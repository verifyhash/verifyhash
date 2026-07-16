#!/usr/bin/env python3
"""test_env_invariance.py — T-VHENV.1: pin ENVIRONMENT INVARIANCE (locale/TZ)
for the einvoice CLI: the same invocation must produce byte-identical stdout
(and stderr) and the identical exit code no matter what LANG/LC_ALL/TZ the
calling process runs under.

MEASURE-FIRST FINDINGS (read/measured 2026-07-16, BEFORE this file was written)
-------------------------------------------------------------------------------
* Source audit: ``grep -nE 'locale|setlocale|strftime|datetime\\.now|
  time\\.localtime|os\\.getcwd|%[aAbBcpxX]|astimezone|utcnow|time\\.time'``
  over einvoice/einvoice/*.py found ZERO locale- or wall-clock-dependent
  formatting in the product. The only hits were false positives: the
  ``%AZP25`` Azure escape literal in report.py, currency/country code-list
  strings containing "TZ"/"STZ" in codelists.py, ``datetime.date.fromisoformat``
  in rules.py (a pure lexical parse of xs:date — no clock, no zone), and the
  CII field name ``cii_delivery_datetime_string_present``. receipt.py's own
  docstring asserts "no wall-clock" by design.
* What siblings already pin (NOT duplicated here): test_idempotence.py pins
  within-process byte idempotence plus cross-process byte identity under
  PYTHONHASHSEED 0/1/42 — the HASH-SEED axis. test_golden_snapshot.py pins a
  normalized verdict/rule projection against committed goldens. NEITHER varies
  LANG/LC_ALL/TZ; the locale/TZ axis was genuinely unpinned.
* Live measurement (this box, python3 -m einvoice as a subprocess): all seven
  invocation shapes below were run under the full matrix {C, C.UTF-8,
  en_US.utf8} x {UTC, Pacific/Kiritimati} (en_US.utf8 is the only non-C
  locale installed here; no non-English UTF-8 locale exists on this machine).
  Every shape produced ONE stdout sha256 and ONE exit code across all six
  legs — e.g. ``validate <valid> --json`` -> sha 38ec52210ae715f8 / exit 0 in
  all six. ZERO divergence was measured, so per the task spec NO product
  source was modified: this file simply pins the already-true property as a
  regression guard.

WHAT THIS FILE BINDS
--------------------
Each invocation below is run as a REAL subprocess (``python3 -m einvoice``,
cwd = this directory, exactly like test_cli_batch.py) once per environment
leg, where a leg is an explicit env dict (``dict(os.environ)`` with LANG,
LC_ALL and TZ overridden — runner-independent by construction, per the task
spec). Across ALL legs of one invocation, stdout must be BYTE-identical,
stderr byte-identical, and the exit code identical. Nothing is normalized.

Invocations (valid + invalid inputs, --json + default text form):
  * ``validate`` on one valid fixture         (text and --json)
  * ``validate`` on one invalid fixture       (text and --json)
  * ``validate-batch`` over a small MIXED dir (text and --json; the dir holds
    one passing + one failing invoice, built once in setUpClass so every leg
    sees the identical paths)
  * ``receipt`` on the valid and the invalid fixture, each with and without
    ``--json`` (the receipt is ALWAYS one canonical JSON document — cli.py
    documents that --quiet/--json do not change it — but both spellings are
    exercised so a future flag regression cannot hide).

Environment matrix:
  * LANG/LC_ALL in {C, C.UTF-8}  — always run;
  * plus ONE non-English UTF-8 locale IF installed: ``locale -a`` is probed
    at class setup against a candidate list (de_DE/fr_FR/es_ES/it_IT/ja_JP/
    nl_NL/pt_PT/pl_PL/sv_SE .UTF-8, matched against locale -a's normalized
    spelling, e.g. "de_DE.utf8"); when none is installed that leg SKIPS
    cleanly with a message — it never fails (this box: only en_US.utf8 is
    installed, which is English, so the leg skips here);
  * crossed with TZ in {UTC, Pacific/Kiritimati} (UTC+14 — the most extreme
    forward offset, maximizing any local-date disagreement with UTC).

PYTHONHASHSEED is held FIXED at "0" in every leg. That is deliberately NOT
re-testing the hash-seed axis (test_idempotence.py owns it, seeds 0/1/42);
it is controlling a confound, so that a byte diff seen by this file can only
come from the locale/TZ axis under test.

HONEST LIMITS: this pins invariance across the environments installed on the
runner. A locale that is not installed cannot be exercised (the probe/skip
above); and the guard is the CLI surface — library callers who format output
themselves are outside its scope.

Standard library only (os/shutil/subprocess/sys/tempfile/unittest); offline,
saxonche-free, no new deps — test_packaging.py stays green. ~15 s runtime
(40 subprocess runs in the base matrix).
"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))

# Same canonical pass/fail pair test_cli.py uses.
VALID_FIXTURE = os.path.join(
    "corpus", "vendored", "valid", "cen-bis3-positive_ubl.xml")
INVALID_FIXTURE = os.path.join(
    "fixtures", "creditnote-invalid-typecode_ubl.xml")

# Locale legs that must always run: POSIX C and C.UTF-8 (glibc spells the
# latter "C.utf8" in `locale -a`, but setting LC_ALL=C.UTF-8 works on any
# modern glibc/musl and both spellings select the same locale).
BASE_LOCALES = ["C", "C.UTF-8"]

# Candidate NON-ENGLISH UTF-8 locales, in preference order. en_* is
# deliberately excluded — the task leg is specifically a non-English one.
NON_ENGLISH_CANDIDATES = [
    "de_DE.UTF-8", "fr_FR.UTF-8", "es_ES.UTF-8", "it_IT.UTF-8",
    "ja_JP.UTF-8", "nl_NL.UTF-8", "pt_PT.UTF-8", "pl_PL.UTF-8",
    "sv_SE.UTF-8",
]

TIMEZONES = ["UTC", "Pacific/Kiritimati"]

TIMEOUT = 180


def _normalize_locale_name(name):
    """Normalize a locale spelling for comparison: de_DE.UTF-8 == de_de.utf8."""
    return name.strip().lower().replace("-", "")


def _probe_non_english_locale():
    """Return (locale_or_None, human_reason).

    Probes ``locale -a`` for the first installed NON_ENGLISH_CANDIDATES entry.
    Any probe failure (missing `locale` binary, non-zero exit) is treated the
    same as "not installed": the leg skips with a message, it never fails —
    exactly what the task requires for an uninstalled locale.
    """
    try:
        proc = subprocess.run(
            ["locale", "-a"], capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, "`locale -a` could not be run (%s)" % (exc,)
    if proc.returncode != 0:
        return None, "`locale -a` exited %d" % proc.returncode
    installed = {
        _normalize_locale_name(line)
        for line in proc.stdout.decode("utf-8", "replace").splitlines()
        if line.strip()
    }
    for cand in NON_ENGLISH_CANDIDATES:
        if _normalize_locale_name(cand) in installed:
            return cand, "found installed non-English locale %s" % cand
    return None, ("no non-English UTF-8 locale installed (probed %d "
                  "candidates against `locale -a`)"
                  % len(NON_ENGLISH_CANDIDATES))


def _env_for(loc, tz):
    """Explicit env dict for one leg: runner env + pinned LANG/LC_ALL/TZ.

    Copying os.environ keeps PATH/PYTHONPATH etc. so the subprocess resolves
    the same interpreter and package as the runner; only the axis under test
    (locale + zone) is overridden. PYTHONHASHSEED is fixed to isolate that
    axis (the hash-seed axis itself is owned by test_idempotence.py).
    """
    env = dict(os.environ)
    env["LANG"] = loc
    env["LC_ALL"] = loc
    env["TZ"] = tz
    env["PYTHONHASHSEED"] = "0"
    return env


def _run_cli(cli_args, env):
    """Run ``python3 -m einvoice <cli_args>`` under an explicit env."""
    return subprocess.run(
        [sys.executable, "-m", "einvoice", *cli_args],
        cwd=HERE, capture_output=True, env=env, timeout=TIMEOUT)


class TestEnvInvariance(unittest.TestCase):
    """Byte-identical stdout/stderr + identical exit code across env legs."""

    maxDiff = None

    @classmethod
    def setUpClass(cls):
        for rel in (VALID_FIXTURE, INVALID_FIXTURE):
            if not os.path.isfile(os.path.join(HERE, rel)):
                raise AssertionError("required fixture missing: %s" % rel)
        # Small MIXED batch dir: one passing + one failing invoice. Built
        # ONCE so every environment leg validates the identical paths (batch
        # output embeds source paths; a per-leg temp dir would trivially — and
        # falsely — diverge).
        cls.batch_dir = tempfile.mkdtemp(prefix="einvoice-envinv-")
        shutil.copy(os.path.join(HERE, VALID_FIXTURE),
                    os.path.join(cls.batch_dir, "a-valid_ubl.xml"))
        shutil.copy(os.path.join(HERE, INVALID_FIXTURE),
                    os.path.join(cls.batch_dir, "b-invalid_ubl.xml"))
        cls.non_english_locale, cls.non_english_reason = (
            _probe_non_english_locale())

        # (subcommand args, human label) — every task-required invocation.
        cls.invocations = [
            (["validate", VALID_FIXTURE], "validate valid text"),
            (["validate", VALID_FIXTURE, "--json"], "validate valid json"),
            (["validate", INVALID_FIXTURE], "validate invalid text"),
            (["validate", INVALID_FIXTURE, "--json"], "validate invalid json"),
            (["validate-batch", cls.batch_dir], "validate-batch text"),
            (["validate-batch", cls.batch_dir, "--json"],
             "validate-batch json"),
            (["receipt", VALID_FIXTURE], "receipt valid default"),
            (["receipt", VALID_FIXTURE, "--json"], "receipt valid --json"),
            (["receipt", INVALID_FIXTURE], "receipt invalid default"),
            (["receipt", INVALID_FIXTURE, "--json"], "receipt invalid --json"),
        ]

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.batch_dir, ignore_errors=True)

    def _assert_invariant_across(self, locales):
        """Run every invocation under locales x TIMEZONES; assert one output."""
        legs = [(loc, tz) for loc in locales for tz in TIMEZONES]
        self.assertGreaterEqual(len(legs), 2)
        for cli_args, label in self.invocations:
            ref = None  # (leg, exit_code, stdout, stderr)
            for loc, tz in legs:
                proc = _run_cli(cli_args, _env_for(loc, tz))
                leg = "LANG=LC_ALL=%s TZ=%s" % (loc, tz)
                if ref is None:
                    ref = (leg, proc.returncode, proc.stdout, proc.stderr)
                    continue
                self.assertEqual(
                    proc.returncode, ref[1],
                    "[%s] exit code diverged: %s -> %d, but %s -> %d"
                    % (label, ref[0], ref[1], leg, proc.returncode))
                self.assertEqual(
                    proc.stdout, ref[2],
                    "[%s] stdout bytes diverged between %s and %s"
                    % (label, ref[0], leg))
                self.assertEqual(
                    proc.stderr, ref[3],
                    "[%s] stderr bytes diverged between %s and %s"
                    % (label, ref[0], leg))
            # The reference leg must itself be a sane run of the real CLI —
            # a matrix of identical crashes must not pass silently. Every
            # documented verdict exit is allowed (0 pass, 1 fail, 3 parse
            # error); 2 (usage) or a traceback exit would mean the harness
            # itself is wired wrong.
            self.assertIn(
                ref[1], (0, 1, 3),
                "[%s] unexpected exit %d under %s (stderr: %r)"
                % (label, ref[1], ref[0], ref[3][:400]))

    def test_base_matrix_c_and_c_utf8(self):
        """{C, C.UTF-8} x {UTC, Pacific/Kiritimati}: byte-identical output.

        4 legs x 10 invocations = 40 subprocess runs; validate + batch +
        receipt, valid + invalid, --json + text, all compared byte-for-byte.
        """
        self._assert_invariant_across(BASE_LOCALES)

    def test_non_english_locale_leg(self):
        """One installed non-English UTF-8 locale x both TZs, against C/UTC.

        Cleanly SKIPS (never fails) when no non-English UTF-8 locale is
        installed — per the task spec and this box's reality (only C, C.UTF-8,
        POSIX and en_US.utf8 exist here). When a locale IS found, its two TZ
        legs are compared against the C/UTC baseline within the same run, so
        the non-English output must byte-match the C output too, not merely
        be self-consistent.
        """
        if self.non_english_locale is None:
            self.skipTest(
                "non-English locale leg skipped: %s" % self.non_english_reason)
        self._assert_invariant_across(["C", self.non_english_locale])


if __name__ == "__main__":
    unittest.main(verbosity=2)

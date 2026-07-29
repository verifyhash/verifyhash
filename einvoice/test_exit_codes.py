#!/usr/bin/env python3
"""test_exit_codes.py — pin the einvoice CLI exit-code contract (T-VHDX.1).

Companion to ``EXIT-CODES.md``. For every documented terminal state this test
drives the LIVE CLI on a committed fixture and asserts BOTH:

  (a) the exact process return code, and
  (b) that the documented, actionable message substring appears on the
      documented stream (stdout or stderr) — we grep the message, not just the
      code, so a silent code that lost its explanation would still fail.

Because it recomputes against ``einvoice.cli.main`` (and a subprocess spot
check), it fails if any exit code or its actionable message ever drifts. It
adds NO new fixtures with real company data — it reuses the exact fixtures
already referenced by ``test_cli.py``:

  * a business-rule-clean UBL invoice        -> exit 0 (PASS)
  * an invalid UBL *CreditNote* (bad BT-3)   -> exit 1 (BR-CL-01 fatal)
  * a deliberately-truncated XML document    -> exit 3 (not-well-formed)
  * a missing file / unknown profile (argv)  -> exit 2 (usage)

``validate --baseline <prev-report.json>`` (regression-diff mode) is covered on
both sides of its contract, by the same rule: its VALIDATION outcomes (0 / 1 /
3) and its USAGE outcomes (2 — an unreadable, non-JSON or directory baseline, a
baseline captured under a DIFFERENT ``--profile`` than the run gates with, or
an incompatible ``--format``) are all re-derived by driving the real CLI. The
diff itself is written and tested in ``test_report_diff.py``; what is pinned
HERE is only which row of the table above each outcome lands on. Baselines are
written into a ``tempfile`` from the existing fixtures — still no new committed
fixtures.

Fast, stdlib-only, offline. Documentation + contract test only: it changes no
validation, rule, or report code.
"""

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.cli import (  # noqa: E402
    main, EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE, EXIT_INT, EXIT_TERM,
)

# Reused verbatim from test_cli.py — no new fixtures introduced.
PASS_FIXTURE = os.path.join(HERE, "corpus", "vendored", "valid",
                            "cen-bis3-positive_ubl.xml")
FAIL_FIXTURE = os.path.join(HERE, "fixtures",
                            "creditnote-invalid-typecode_ubl.xml")
MALFORMED_XML = b"<Invoice><never-closed>"


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


class Fixtures(unittest.TestCase):
    def test_reused_fixtures_present(self):
        self.assertTrue(os.path.isfile(PASS_FIXTURE), PASS_FIXTURE)
        self.assertTrue(os.path.isfile(FAIL_FIXTURE), FAIL_FIXTURE)


class ExitCode0(unittest.TestCase):
    """0 = success / no fatal violations."""

    def test_pass_returncode_and_message(self):
        with _Capture(["validate", PASS_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)
            # Documented actionable message on stdout.
            self.assertIn("PASS:", cap.out)
            self.assertIn("all implemented fatal rules", cap.out)


class ExitCode1(unittest.TestCase):
    """1 = not-valid verdict / fatal violation. A UBL CreditNote is really
    validated through the shared EN 16931 engine (T-VHCN.2), so an invalid one
    folds into THIS code via its real business-rule fatal (here BR-CL-01, an
    out-of-range BT-3 credit-note type code) — not a separate code."""

    def test_fatal_returncode_and_message(self):
        with _Capture(["validate", FAIL_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_FAIL)
            # Documented actionable message: FAIL + the failing rule id.
            self.assertIn("FAIL:", cap.out)
            self.assertIn("BR-CL-01", cap.out)

    def test_invalid_creditnote_is_not_a_new_code(self):
        # The honest contract: an invalid UBL CreditNote never silently passes
        # and never mints a distinct code; it is exit 1 like any invalid doc.
        with _Capture(["validate", FAIL_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_FAIL)
            self.assertNotEqual(cap.rc, EXIT_OK)


class ExitCode2(unittest.TestCase):
    """2 = usage error (bad args / missing file / unknown flag value)."""

    def test_missing_file_returncode_and_message(self):
        with _Capture(["validate", "does-not-exist.xml"]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)
            self.assertIn("error: no such file", cap.err)

    def test_no_subcommand_returncode_and_message(self):
        with _Capture([]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)
            self.assertIn("usage:", cap.err)

    def test_unknown_profile_returncode_and_message(self):
        with _Capture(["validate", "--profile=bogus", PASS_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)
            self.assertIn("error: unknown profile", cap.err)


class ExitCode3(unittest.TestCase):
    """3 = not-well-formed XML / parse error (validate only)."""

    def test_not_well_formed_returncode_and_message(self):
        fd, tmp = tempfile.mkstemp(suffix=".xml")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(MALFORMED_XML)
            with _Capture(["validate", tmp]) as cap:
                self.assertEqual(cap.rc, EXIT_PARSE)
                # Documented actionable message on stderr.
                self.assertIn("S-WF: input is not well-formed XML", cap.err)
        finally:
            os.unlink(tmp)


class BaselineRegressionDiff(unittest.TestCase):
    """``validate --baseline <prev-report.json>`` — the regression gate — lands
    on the SAME four rows as every other invocation, and nothing else.

    The split this pins is the one that was measured broken (2026-07-29,
    T-VHGATE.3): the diff's own outcomes are verdicts (`0` no new fatal, `1` a
    NEW fatal, `3` the current invoice cannot be parsed), while a baseline the
    tool could not read at all is not a verdict about anyone's invoice — it is
    the documented usage error `2`, exactly like a missing invoice file. All
    four usage rows returned `1` before, i.e. a CI job adopting the gate got a
    red build blaming its invoices for a setup mistake.
    """

    def _baseline_from(self, fixture, tmpdir, name="baseline.json"):
        """Capture a REAL report for ``fixture`` through the CLI and write it
        where ``--baseline`` will read it. No hand-written baseline shape: the
        file is whatever the shipped ``--json`` emitter produces."""
        with _Capture(["validate", "--json", fixture]) as cap:
            self.assertIn('"violations"', cap.out, cap.err)
        target = os.path.join(tmpdir, name)
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(cap.out)
        return target

    # -- validation outcomes: unchanged, still the verdict codes -------------
    def test_only_pre_existing_fatals_is_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = self._baseline_from(FAIL_FIXTURE, tmp)
            with _Capture(["validate", "--baseline", base,
                           FAIL_FIXTURE]) as cap:
                self.assertEqual(cap.rc, EXIT_OK, cap.err)
                # The diff DOCUMENT is the output, on stdout, as before.
                self.assertIn('"einvoice-conformance-diff/v1"', cap.out)
                self.assertIn('"new_fatal_count":0', cap.out)

    def test_new_fatal_vs_baseline_is_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = self._baseline_from(PASS_FIXTURE, tmp)
            with _Capture(["validate", "--baseline", base,
                           FAIL_FIXTURE]) as cap:
                self.assertEqual(cap.rc, EXIT_FAIL, cap.err)
                self.assertIn('"einvoice-conformance-diff/v1"', cap.out)
                self.assertIn("BR-CL-01", cap.out)

    def test_unparseable_current_invoice_is_three(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = self._baseline_from(PASS_FIXTURE, tmp)
            broken = os.path.join(tmp, "broken.xml")
            with open(broken, "wb") as fh:
                fh.write(MALFORMED_XML)
            with _Capture(["validate", "--baseline", base, broken]) as cap:
                self.assertEqual(cap.rc, EXIT_PARSE, cap.err)
                # Still a parseable document, not a bare stderr line.
                self.assertIn('"not-well-formed"', cap.out)

    # -- usage outcomes: the four first-run mistakes, all code 2 -------------
    def test_missing_baseline_file_is_usage(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = os.path.join(tmp, "no-such-baseline.json")
            with _Capture(["validate", "--baseline", missing,
                           PASS_FIXTURE]) as cap:
                self.assertEqual(cap.rc, EXIT_USAGE, cap.err)
                self.assertIn("error: cannot read baseline", cap.err)
                self.assertIn(missing, cap.err)
                self.assertEqual(cap.out, "")

    def test_non_json_baseline_is_usage(self):
        with tempfile.TemporaryDirectory() as tmp:
            garbage = os.path.join(tmp, "not-json.json")
            with open(garbage, "w", encoding="utf-8") as fh:
                fh.write("this is not json {")
            with _Capture(["validate", "--baseline", garbage,
                           PASS_FIXTURE]) as cap:
                self.assertEqual(cap.rc, EXIT_USAGE, cap.err)
                self.assertIn("is not valid JSON", cap.err)
                self.assertEqual(cap.out, "")

    def test_directory_baseline_is_usage(self):
        with tempfile.TemporaryDirectory() as tmp:
            with _Capture(["validate", "--baseline", tmp,
                           PASS_FIXTURE]) as cap:
                self.assertEqual(cap.rc, EXIT_USAGE, cap.err)
                self.assertIn("error: cannot read baseline", cap.err)
                self.assertEqual(cap.out, "")

    def test_incompatible_format_is_usage(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = self._baseline_from(PASS_FIXTURE, tmp)
            with _Capture(["validate", "--baseline", base, "--format", "sarif",
                           PASS_FIXTURE]) as cap:
                self.assertEqual(cap.rc, EXIT_USAGE, cap.err)
                self.assertIn("--baseline", cap.err)
                self.assertIn("sarif", cap.err)
                self.assertEqual(cap.out, "")

    def _report_baseline_from(self, fixture, tmpdir, profile,
                              name="baseline-declared.json"):
        """Capture a baseline through ``python3 -m einvoice.report --format
        json`` — the emitter that DOES record ``profile`` in the document —
        and write it where ``--baseline`` will read it. Driven as a real
        subprocess, like every other row here; no hand-written shape."""
        proc = subprocess.run(
            [sys.executable, "-m", "einvoice.report", "--profile", profile,
             "--format", "json", fixture],
            cwd=HERE, capture_output=True)
        payload = proc.stdout.decode("utf-8")
        # The whole point of this capture: the document declares its profile.
        self.assertEqual(json.loads(payload).get("profile"), profile,
                         proc.stderr)
        target = os.path.join(tmpdir, name)
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(payload)
        return target

    # -- the baseline's own profile is a PRECONDITION, not an assumption ----
    def test_mismatched_declared_profile_is_usage(self):
        """MEASURED defect (2026-07-29, T-VHGATE.7): an ``en16931`` baseline
        gated with ``--profile xrechnung`` scored the whole BR-DE-* layer as
        ``new_violations`` and exited `1` — a red build blaming an invoice
        that never changed for what was a flag change. It is a setup error,
        so it is row `2`, and it names BOTH profiles so the fix is obvious."""
        with tempfile.TemporaryDirectory() as tmp:
            base = self._report_baseline_from(FAIL_FIXTURE, tmp, "en16931")
            with _Capture(["validate", "--profile", "xrechnung",
                           "--baseline", base, FAIL_FIXTURE]) as cap:
                self.assertEqual(cap.rc, EXIT_USAGE, cap.err)
                # No half-computed verdict can reach a parser.
                self.assertEqual(cap.out, "")
                self.assertIn("error: baseline", cap.err)
                self.assertIn("en16931", cap.err)
                self.assertIn("xrechnung", cap.err)
                self.assertIn(base, cap.err)
                # This entry point's own banner, as with every other row 2.
                self.assertIn("usage: einvoice validate", cap.err)
                self.assertNotIn("einvoice.report", cap.err)

    def test_matching_declared_profile_is_recorded_in_the_document(self):
        """When the baseline declares the SAME profile, nothing is refused and
        the diff carries it forward as ``baseline_profile`` — additive on the
        unchanged ``einvoice-conformance-diff/v1`` id."""
        with tempfile.TemporaryDirectory() as tmp:
            base = self._report_baseline_from(FAIL_FIXTURE, tmp, "xrechnung")
            with _Capture(["validate", "--profile", "xrechnung",
                           "--baseline", base, FAIL_FIXTURE]) as cap:
                self.assertEqual(cap.rc, EXIT_OK, cap.err)
                doc = json.loads(cap.out)
                self.assertEqual(doc["schema"], "einvoice-conformance-diff/v1")
                self.assertEqual(doc["baseline_profile"], "xrechnung")
                self.assertEqual(doc["profile"], "xrechnung")
                self.assertEqual(doc["new_fatal_count"], 0)
                # A checked baseline says nothing extra on stderr.
                self.assertNotIn("could not be checked", cap.err)

    def test_undeclared_profile_still_diffs_but_says_so(self):
        """The console script's own ``--json`` capture shape declares no
        ``profile``. That baseline MUST keep working — same exit code, same
        document body, no new key — but silence must never mean 'checked', so
        one ``note:`` line on stderr names the profile the run used."""
        with tempfile.TemporaryDirectory() as tmp:
            base = self._baseline_from(FAIL_FIXTURE, tmp)
            with open(base, encoding="utf-8") as fh:
                self.assertNotIn("profile", json.load(fh))
            with _Capture(["validate", "--profile", "en16931",
                           "--baseline", base, FAIL_FIXTURE]) as cap:
                self.assertEqual(cap.rc, EXIT_OK, cap.err)
                doc = json.loads(cap.out)
                self.assertEqual(doc["schema"], "einvoice-conformance-diff/v1")
                self.assertNotIn("baseline_profile", doc)
                self.assertEqual(doc["new_fatal_count"], 0)
                notes = [ln for ln in cap.err.splitlines() if ln.strip()]
                self.assertEqual(len(notes), 1, cap.err)
                self.assertTrue(notes[0].startswith("note: baseline"), notes)
                self.assertIn("en16931", notes[0])
                self.assertIn(base, notes[0])

    # -- the banner belongs to the command the user actually typed ----------
    def test_usage_banner_is_this_entry_points_own(self):
        """A user who typed ``einvoice validate`` is never shown the syntax of
        ``python3 -m einvoice.report`` (which advertises --pretty / --recurse,
        two flags this command does not accept)."""
        with tempfile.TemporaryDirectory() as tmp:
            base = self._baseline_from(PASS_FIXTURE, tmp)
            cases = [
                ["validate", "--baseline", os.path.join(tmp, "gone.json"),
                 PASS_FIXTURE],
                ["validate", "--baseline", tmp, PASS_FIXTURE],
                ["validate", "--baseline", base, "--format", "sarif",
                 PASS_FIXTURE],
            ]
            for argv in cases:
                with self.subTest(argv=argv):
                    with _Capture(argv) as cap:
                        self.assertEqual(cap.rc, EXIT_USAGE, cap.err)
                        self.assertNotIn("einvoice.report", cap.err)
                        self.assertIn("usage: einvoice validate", cap.err)
                        self.assertNotIn("--recurse", cap.err)

    # -- the sibling entry point's own codes are untouched ------------------
    def test_report_entry_point_keeps_its_legacy_usage_code(self):
        """``einvoice.report`` spends `1` on usage errors. That is ITS
        convention and is deliberately NOT changed by the translation above:
        the dialect conversion lives at the console script's boundary, so no
        existing `python3 -m einvoice.report` caller sees a new code."""
        proc = subprocess.run(
            [sys.executable, "-m", "einvoice.report", "--bogusflag",
             PASS_FIXTURE], cwd=HERE, capture_output=True)
        self.assertEqual(proc.returncode, EXIT_FAIL, proc.stderr)
        # Its banner is still its own, too — nothing about that surface moved.
        self.assertIn(b"usage: python3 -m einvoice.report", proc.stderr)
        with tempfile.TemporaryDirectory() as tmp:
            proc = subprocess.run(
                [sys.executable, "-m", "einvoice.report", "--baseline",
                 os.path.join(tmp, "gone.json"), PASS_FIXTURE],
                cwd=HERE, capture_output=True)
            self.assertEqual(proc.returncode, EXIT_FAIL, proc.stderr)
            self.assertIn(b"error: cannot read baseline", proc.stderr)


class SignalAbortCodes(unittest.TestCase):
    """130/143 = clean SIGINT/SIGTERM abort (T-VHPIPE.3, additive rows).

    The LIVE mid-run signal behavior — documented code, quiet stderr, no
    stray einvoice-stdin-* temp file — is driven end-to-end by
    ``test_interrupt.py``; here the contract table itself is pinned: the
    symbolic constants equal the 128+signal shell conventions, are distinct
    from every pre-existing code, and are documented in EXIT-CODES.md."""

    def test_constants_are_the_shell_conventions(self):
        self.assertEqual(EXIT_INT, 130)    # 128 + SIGINT(2)
        self.assertEqual(EXIT_TERM, 143)   # 128 + SIGTERM(15)

    def test_codes_are_additive_never_repurposed(self):
        existing = {EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE, 141}
        self.assertNotIn(EXIT_INT, existing)
        self.assertNotIn(EXIT_TERM, existing)

    def test_documented_in_exit_codes_md(self):
        with open(os.path.join(HERE, "EXIT-CODES.md"), encoding="utf-8") as fh:
            doc = fh.read()
        self.assertIn("`130`", doc)
        self.assertIn("`143`", doc)
        low = doc.lower()
        self.assertIn("sigint", low)
        self.assertIn("sigterm", low)


class SubprocessSpotCheck(unittest.TestCase):
    """Prove the packaged entry point yields the same codes, not just the
    in-process main()."""

    def _run(self, *argv):
        return subprocess.run(
            [sys.executable, "-m", "einvoice", *argv],
            cwd=HERE, capture_output=True)

    def test_pass_and_fail_via_module(self):
        ok = self._run("validate", PASS_FIXTURE)
        self.assertEqual(ok.returncode, EXIT_OK, ok.stderr)
        bad = self._run("validate", FAIL_FIXTURE)
        self.assertEqual(bad.returncode, EXIT_FAIL, bad.stderr)


if __name__ == "__main__":
    unittest.main()

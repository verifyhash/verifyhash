#!/usr/bin/env python3
"""test_entry_point_matrix.py — the two entry points may DIVERGE, but only on
purpose (T-VHGATE.1).

WHY THIS FILE EXISTS (measured, not hypothetical). This wheel ships two command
lines: the ``einvoice`` console script (:mod:`einvoice.cli`) and the sibling
module surface ``python3 -m einvoice.report`` (:mod:`einvoice.report`). Each has
its own hand-rolled argv loop, and for a long time the difference between the
two flag sets was nobody's decision — it was just what the two loops happened to
consume. The cost of that, measured 2026-07-29 at HEAD 8a4ad5b: ``--baseline``
(the regression gate that fails only on a *new* fatal, which is the feature that
converts a cautious ERP evaluator) worked as ``python3 -m einvoice.report
--baseline ...`` and answered ``error: unexpected argument '--baseline'`` — exit
2 — on ``einvoice validate``, the only command the docs actually teach. It was
mentioned 0 times in ``einvoice --help``.

So :data:`einvoice.cli.ENTRY_POINT_CAPABILITIES` now declares, per long option,
WHICH entry points accept it and WHY the asymmetric ones are asymmetric. This
file is the guard that keeps that table honest, and it is DERIVED, never
hand-listed: the per-entry-point flag sets come from the two modules' own
acceptance expressions (``a == "--x"``, ``a.startswith("--x=")``,
``"--x" in args``, ``a in ("--x", "-h")``) parsed out of the real source, so:

  * a flag accepted by ONE entry point and silently absent from the other with
    NO row in the matrix FAILS here (that is the exact defect above);
  * a row whose ``accepted_by`` disagrees with what the parsers really do FAILS;
  * an asymmetric row with no stated reason FAILS.

Three legs:
  (a) STRUCTURE — the matrix covers exactly the union of the two derived flag
      sets, every row names real entry points, and every row carries a reason.
  (b) TRUTH — each row's ``accepted_by`` equals the derived acceptance, and the
      guard's own detector is exercised on fabricated inputs (a negative
      control), so a green run cannot mean "the check does nothing".
  (c) BEHAVIOUR — the rows that matter are driven live: ``--baseline`` really
      is accepted by ``einvoice validate`` and really produces the diff exit
      contract; ``--pretty``/``--recurse`` really are NOT accepted by the
      console script; and ``einvoice.report``'s reasoned ``--lang`` refusal is
      still byte-for-byte the sentence the matrix says it is.

Standard library only, offline, no network, fast.
Run: python3 test_entry_point_matrix.py
"""

import io
import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import einvoice.cli as cli            # noqa: E402  (after sys.path fix)
import einvoice.report as report      # noqa: E402

BROKEN = os.path.join(HERE, "examples", "01-missing-fields", "broken.xml")
FIXED = os.path.join(HERE, "examples", "01-missing-fields", "fixed.xml")

#: The exact refusal ``einvoice.report`` must keep for ``--lang`` outside
#: ``--explain``. Pinned as a literal HERE on purpose: this is the sentence the
#: matrix's "lang" row points at, and the whole point of the row is that the
#: reasoning survives a future edit of report.py.
LANG_REFUSAL = ("error: --lang applies only to --explain; a report document is "
                "machine-facing and language-neutral (use 'einvoice validate "
                "--lang de' for a German human summary)")


# --------------------------------------------------------------------------- #
# Derivation — read the REAL parsers, never a parallel hand-kept list.
# --------------------------------------------------------------------------- #
#: The four shapes in which either module ACCEPTS (consumes) a long option.
#: Anything else in the source — a message body, a docstring, a matrix key — is
#: not an acceptance and is deliberately not counted.
_ACCEPTANCE_PATTERNS = (
    re.compile(r'\ba == "(--[a-z][a-z-]+)"'),          # a == "--profile"
    re.compile(r'\ba in \("(--[a-z][a-z-]+)"'),        # a in ("--help", "-h")
    re.compile(r'\ba\.startswith\("(--[a-z][a-z-]+)="\)'),  # --profile=value
    re.compile(r'"(--[a-z][a-z-]+)" in args\b'),       # "--json" in args
)


def _source(module):
    with open(module.__file__, encoding="utf-8") as fh:
        return fh.read()


def accepted_flag_names(module):
    """The long options ``module``'s argv loop really consumes, as bare names
    (no leading dashes), derived from its own acceptance expressions."""
    src = _source(module)
    found = set()
    for pat in _ACCEPTANCE_PATTERNS:
        for m in pat.findall(src):
            found.add(m.lstrip("-"))
    return found


def derived_capabilities():
    """{entry point name -> set of accepted flag names}, straight from source."""
    return {
        "einvoice": accepted_flag_names(cli),
        "einvoice.report": accepted_flag_names(report),
    }


def undeclared_divergences(derived, matrix):
    """The core detector, kept a PURE function so leg (b) can prove it bites.

    Returns a sorted list of complaint strings: a flag that at least one entry
    point accepts but which has no matrix row, or a row whose declared
    ``accepted_by`` disagrees with the derived reality.
    """
    problems = []
    every = set()
    for names in derived.values():
        every |= names
    for name in sorted(every):
        row = matrix.get(name)
        if row is None:
            takers = sorted(ep for ep, s in derived.items() if name in s)
            missers = sorted(ep for ep in derived if name not in derived[ep])
            problems.append(
                "%s is accepted by %s and absent from %s with no matrix row"
                % (name, "/".join(takers), "/".join(missers) or "nothing"))
            continue
        declared = tuple(row.get("accepted_by", ()))
        real = tuple(ep for ep in sorted(derived) if name in derived[ep])
        if tuple(sorted(declared)) != tuple(sorted(real)):
            problems.append(
                "%s: matrix says %r, parsers say %r"
                % (name, declared, real))
    for name in sorted(matrix):
        if name not in every:
            problems.append(
                "%s has a matrix row but no entry point accepts it" % name)
    return sorted(problems)


# --------------------------------------------------------------------------- #
# In-process drivers.
# --------------------------------------------------------------------------- #
class _Capture:
    def __init__(self, fn, argv):
        self.fn, self.argv = fn, argv

    def __enter__(self):
        self._out, self._err = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = io.StringIO(), io.StringIO()
        self.rc = self.fn(self.argv)
        self.out, self.err = sys.stdout.getvalue(), sys.stderr.getvalue()
        return self

    def __exit__(self, *exc):
        sys.stdout, sys.stderr = self._out, self._err
        return False


def drive_cli(argv):
    with _Capture(cli.main, argv) as cap:
        return cap.rc, cap.out, cap.err


def drive_report(argv):
    with _Capture(report.main, argv) as cap:
        return cap.rc, cap.out, cap.err


# --------------------------------------------------------------------------- #
# Leg (a): structure.
# --------------------------------------------------------------------------- #
class MatrixStructure(unittest.TestCase):
    def test_constant_exists_and_is_named_for_entry_points(self):
        self.assertTrue(hasattr(cli, "ENTRY_POINT_CAPABILITIES"))
        self.assertTrue(hasattr(cli, "ENTRY_POINTS"))
        self.assertEqual(tuple(sorted(cli.ENTRY_POINTS)),
                         tuple(sorted(derived_capabilities())))

    def test_matrix_is_commented(self):
        # A capability matrix nobody explained is the accident this task
        # replaced. Require a real comment block immediately above it.
        src = _source(cli).splitlines()
        idx = next(i for i, line in enumerate(src)
                   if line.startswith("ENTRY_POINT_CAPABILITIES"))
        lead = 0
        j = idx - 1
        while j >= 0 and src[j].lstrip().startswith("#"):
            lead += 1
            j -= 1
        self.assertGreaterEqual(
            lead, 10,
            "ENTRY_POINT_CAPABILITIES needs its rationale in the source, not "
            "in a commit message (found %d comment lines above it)" % lead)

    def test_every_row_is_well_formed_and_reasoned(self):
        for name, row in sorted(cli.ENTRY_POINT_CAPABILITIES.items()):
            self.assertFalse(name.startswith("-"),
                             "%r: matrix keys carry no dashes (they must not "
                             "look like parser literals)" % name)
            accepted = row.get("accepted_by")
            self.assertIsInstance(accepted, tuple, name)
            self.assertTrue(accepted, "%s: accepted_by is empty" % name)
            for ep in accepted:
                self.assertIn(ep, cli.ENTRY_POINTS,
                              "%s names unknown entry point %r" % (name, ep))
            why = row.get("why", "")
            self.assertGreaterEqual(
                len(why), 60,
                "%s: an entry-point divergence needs a stated reason, not a "
                "label" % name)

    def test_asymmetric_rows_say_why(self):
        # The rows that matter most: a flag only one surface takes. Its reason
        # must actually mention the surface that does not take it.
        for name, row in sorted(cli.ENTRY_POINT_CAPABILITIES.items()):
            if len(row["accepted_by"]) == len(cli.ENTRY_POINTS):
                continue
            missing = [ep for ep in cli.ENTRY_POINTS
                       if ep not in row["accepted_by"]]
            why = row["why"]
            self.assertTrue(
                any(ep in why for ep in missing)
                or "console script" in why,
                "%s is refused by %s but its reason never mentions it: %r"
                % (name, "/".join(missing), why))


# --------------------------------------------------------------------------- #
# Leg (b): truth — and a negative control on the detector itself.
# --------------------------------------------------------------------------- #
class MatrixTruth(unittest.TestCase):
    def test_matrix_matches_the_real_parsers(self):
        problems = undeclared_divergences(derived_capabilities(),
                                          cli.ENTRY_POINT_CAPABILITIES)
        self.assertEqual(
            problems, [],
            "entry-point capability matrix drifted from the parsers:\n  "
            + "\n  ".join(problems))

    def test_baseline_row_records_the_flag_this_task_landed(self):
        derived = derived_capabilities()
        self.assertIn("baseline", derived["einvoice"],
                      "einvoice.cli no longer parses --baseline")
        self.assertIn("baseline", derived["einvoice.report"])
        row = cli.ENTRY_POINT_CAPABILITIES["baseline"]
        self.assertEqual(tuple(sorted(row["accepted_by"])),
                         ("einvoice", "einvoice.report"))

    def test_detector_catches_an_undeclared_new_flag(self):
        # NEGATIVE CONTROL: invent a flag one surface accepts, leave it out of
        # the matrix, and require the detector to complain. Without this, a
        # green suite would not prove the guard does anything.
        derived = {"einvoice": {"widget"}, "einvoice.report": set()}
        problems = undeclared_divergences(derived, {})
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("widget", problems[0])
        self.assertIn("no matrix row", problems[0])

    def test_detector_catches_a_row_that_lies(self):
        derived = {"einvoice": {"widget"}, "einvoice.report": set()}
        matrix = {"widget": {"accepted_by": ("einvoice", "einvoice.report"),
                             "why": "x" * 80}}
        problems = undeclared_divergences(derived, matrix)
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("parsers say", problems[0])

    def test_detector_catches_a_phantom_row(self):
        problems = undeclared_divergences(
            {"einvoice": set(), "einvoice.report": set()},
            {"ghost": {"accepted_by": ("einvoice",), "why": "x" * 80}})
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("no entry point accepts it", problems[0])


# --------------------------------------------------------------------------- #
# Leg (c): behaviour — drive the rows, do not just read them.
# --------------------------------------------------------------------------- #
class MatrixBehaviour(unittest.TestCase):
    def test_console_script_accepts_baseline_on_validate(self):
        rc, _out, err = drive_cli(["validate", "--baseline"])
        self.assertEqual(rc, cli.EXIT_USAGE)
        self.assertIn("--baseline needs a value", err)
        self.assertNotIn("unexpected argument", err)

    def test_usage_banner_advertises_baseline(self):
        self.assertIn("--baseline", cli.USAGE)
        rc, out, _err = drive_cli(["--help"])
        self.assertEqual(rc, cli.EXIT_OK)
        self.assertIn("--baseline", out)

    def test_baseline_tolerates_pre_existing_fatals(self):
        with tempfile.TemporaryDirectory() as td:
            base = os.path.join(td, "base.json")
            rc, out, _err = drive_cli(
                ["validate", "--profile", "xrechnung", "--format", "json",
                 BROKEN])
            self.assertEqual(rc, cli.EXIT_FAIL)   # 2 pre-existing fatals
            with open(base, "w", encoding="utf-8") as fh:
                fh.write(out)
            rc, out, _err = drive_cli(
                ["validate", "--profile", "xrechnung", "--baseline", base,
                 BROKEN])
            self.assertEqual(rc, cli.EXIT_OK,
                             "a baseline holding the invoice's own fatals must "
                             "exit 0")
            self.assertIn("einvoice-conformance-diff/v1", out)

    def test_baseline_fails_on_a_new_fatal(self):
        with tempfile.TemporaryDirectory() as td:
            base = os.path.join(td, "clean.json")
            rc, out, _err = drive_cli(
                ["validate", "--profile", "xrechnung", "--format", "json",
                 FIXED])
            self.assertEqual(rc, cli.EXIT_OK)
            with open(base, "w", encoding="utf-8") as fh:
                fh.write(out)
            rc, out, _err = drive_cli(
                ["validate", "--profile", "xrechnung", "--baseline", base,
                 BROKEN])
            self.assertEqual(rc, cli.EXIT_FAIL)
            self.assertIn('"new_fatal_count":2', out.replace(" ", ""))

    def test_both_entry_points_emit_the_same_diff_bytes(self):
        # The delegation claim, checked rather than asserted in prose.
        with tempfile.TemporaryDirectory() as td:
            base = os.path.join(td, "clean.json")
            _rc, out, _err = drive_report(["--format", "json", FIXED])
            with open(base, "w", encoding="utf-8") as fh:
                fh.write(out)
            rc_cli, out_cli, _e = drive_cli(
                ["validate", "--profile", "xrechnung", "--baseline", base,
                 BROKEN])
            rc_rep, out_rep, _e = drive_report(
                ["--profile", "xrechnung", "--baseline", base, BROKEN])
            self.assertEqual(out_cli, out_rep)
            self.assertEqual(rc_cli, rc_rep)

    def test_baseline_is_refused_outside_validate(self):
        for argv in (["validate-batch", "--baseline", "x.json", "examples"],
                     ["receipt", "--baseline", "x.json", FIXED],
                     ["info", "--baseline", "x.json"]):
            rc, _out, err = drive_cli(argv)
            self.assertEqual(rc, cli.EXIT_USAGE, argv)
            self.assertIn("only valid for validate", err)

    def test_console_script_does_not_take_pretty_or_recurse(self):
        # The two flags the matrix says stay on einvoice.report only.
        for flag in ("--pretty", "--recurse"):
            rc, _out, err = drive_cli(["info", flag])
            self.assertEqual(rc, cli.EXIT_USAGE, flag)
            self.assertIn("takes no arguments", err)

    def test_report_keeps_its_reasoned_lang_refusal(self):
        rc, out, err = drive_report(["--lang", "de", BROKEN])
        self.assertNotEqual(rc, 0)
        self.assertIn(LANG_REFUSAL, err)
        self.assertEqual(out, "")

    def test_report_lang_refusal_survives_a_real_subprocess(self):
        proc = subprocess.run(
            [sys.executable, "-m", "einvoice.report", "--lang", "de", BROKEN],
            cwd=HERE, capture_output=True, text=True)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("machine-facing and language-neutral", proc.stderr)

    def test_lang_and_fail_on_are_refused_with_baseline_not_swallowed(self):
        with tempfile.TemporaryDirectory() as td:
            base = os.path.join(td, "base.json")
            _rc, out, _err = drive_report(["--format", "json", FIXED])
            with open(base, "w", encoding="utf-8") as fh:
                fh.write(out)
            rc, _out, err = drive_cli(
                ["validate", "--lang", "de", "--baseline", base, BROKEN])
            self.assertEqual(rc, cli.EXIT_USAGE)
            self.assertIn("language-neutral", err)
            rc, _out, err = drive_cli(
                ["validate", "--fail-on", "warning", "--baseline", base,
                 BROKEN])
            self.assertEqual(rc, cli.EXIT_USAGE)
            self.assertIn("own exit rule", err)


if __name__ == "__main__":
    unittest.main(verbosity=2)

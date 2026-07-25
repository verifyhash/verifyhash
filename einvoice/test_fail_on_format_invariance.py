#!/usr/bin/env python3
"""test_fail_on_format_invariance.py — pin MACHINE-FORMAT report-body
invariance under ``--fail-on`` (T-VHFMTP.7).

WHAT CONTRACT THIS LOCKS
------------------------
``--fail-on {fatal,warning,information}`` is an OPT-IN exit-code severity gate
(``einvoice validate`` / ``validate-batch``). The documented contract
(REPORT-FORMATS.md, cli.py ``--fail-on`` help) is that it gates the EXIT CODE
ONLY: it must NEVER drop, filter, or re-level any finding in a machine-format
report body. An auditor who downloads the SARIF / GitLab Code-Quality / JUnit
(or GitHub / Azure) artifact still sees EVERY violation at its true severity;
turning ``--fail-on`` on or off changes only whether CI passes or fails.

The companion ``test_fail_on.py`` already pins this for the process exit code,
the ``--json`` payload bytes, and the human summary text. It does NOT cover the
sarif / gitlab / junit / github / azure bodies. This file adds that guard.
It is a PURE regression lock: no product source is touched (measure-first found
the property already holds), and the fast registry gates + differential.py stay
green.

MEASURE-FIRST FINDINGS (measured on disk 2026-07-20, BEFORE this was written)
-----------------------------------------------------------------------------
* The machine-format bodies come from ONE surface only —
  ``python3 -m einvoice.report --format {sarif,gitlab,junit,github,azure}``.
  cli.py's ``validate`` emits only text / ``--json`` (``OUTPUT_FORMATS`` is
  ``("text","json")``); it has no ``--format`` flag. So the machine surface and
  the ``--fail-on`` surface are DISTINCT binaries.

  UPDATE (T-VHERG.4, 2026-07-25): the surfaces are no longer distinct binaries —
  ``einvoice validate`` now accepts ``--format <fmt>`` and serves the seven
  report formats by calling ``einvoice.report.render_report``, the same emitter
  dispatch this file drives. The CONTRACT under guard here is unaffected, and for
  the same structural reason: ``--fail-on`` still never reaches
  ``build_report()`` on either surface (the console script applies it strictly
  after the fact, as a threshold over the report's own ``violations`` records, to
  pick the exit code), so a machine body still cannot be filtered or re-levelled
  by it. What changed is that a body byte-equal to the one measured below is now
  ALSO reachable as ``einvoice validate --format sarif``; the cross-surface
  byte-equality of those seven bodies is pinned by ``test_cli_help.py``.
* ``einvoice.report`` has NO ``--fail-on`` flag at all: passing it is a usage
  error. That is the structural reason ``--fail-on`` cannot possibly filter a
  machine body — it is not even a knob there. (Locked in
  ``MachineSurfaceHasNoFailOnKnob`` so a future regression that quietly wires
  ``--fail-on`` into the machine emitter trips this test for re-review.)
* Because ``--fail-on`` never touches ``build_report()`` — the single function
  every emitter (json, sarif, gitlab, junit, github, azure) renders from — the
  emitted machine bytes are IDENTICAL whether or not a pipeline also runs the
  ``einvoice validate`` gate with ``--fail-on``. Measured byte-for-byte equal
  for all five formats on both a multi-severity fixture and a warning-only one.

DIVERGENCE FROM THE TASK'S ILLUSTRATIVE EXAMPLE (honest, measured)
-----------------------------------------------------------------
The task text illustrates "exit 0 without the flag vs 1 with ``--fail-on
fatal`` on a fatal-bearing fixture". That is NOT how the shipped code behaves,
and this test asserts the MEASURED truth instead of the example:

  * ``--fail-on`` DEFAULTS to ``fatal`` (cli.py). So on a fatal-bearing fixture
    the exit code is 1 WITH **and** WITHOUT the flag — a fatal finding crosses
    EVERY threshold, so it is gated at fatal / warning / information and by the
    default alike. The exit code therefore CANNOT differ on a fatal fixture.
  * The exit code only genuinely DIFFERS on a SUB-fatal fixture: a warning-only
    invoice exits 0 by default (== ``--fail-on fatal``) and 1 under
    ``--fail-on warning`` / ``information``. That is the fixture used to prove
    "exit differs while the machine body does not".

So the exit-DIFFERS observation is pinned on the warning-only fixture
(``FailOnGatesExitCodeOnly.test_exit_differs_but_machine_body_unchanged``); the
fatal fixture is used for the complementary half — "an auditor still sees the
FATAL violation, plus every warning, in each machine body" — where the exit
code is constant 1 (asserted, with the reason, in
``test_fatal_fixture_exit_is_constant_body_keeps_all_findings``).

HARNESS: same in-process ``main(argv)`` dispatch ``test_fail_on.py`` drives —
``einvoice.cli.main`` for the ``--fail-on`` exit gate, ``einvoice.report.main``
for the machine bodies — with stdout/stderr captured. Absolute fixture paths,
stdlib only, offline, saxonche-free, sub-second. No new fixtures.
"""

import io
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.cli import main as cli_main, EXIT_OK, EXIT_FAIL  # noqa: E402
from einvoice.report import main as report_main  # noqa: E402

# The machine-format bodies whose invariance under --fail-on this file pins.
# sarif/gitlab/junit are named explicitly (the task's core set); github/azure
# are added for thoroughness. json/text/html/badge are covered elsewhere.
MACHINE_FORMATS = ("sarif", "gitlab", "junit", "github", "azure")

# --- Committed fixtures (no new fixtures introduced) --------------------------
# MULTI: a fatal fixture that ALSO carries warnings, so the machine body must
#   show findings at MORE THAN ONE severity -> proves --fail-on neither DROPS
#   nor RE-LEVELS them. Under --profile xrechnung it yields exactly:
#     BR-CL-01 (fatal), BR-DE-17 (warning), BR-DE-21 (warning).
MULTI_FIXTURE = os.path.join(HERE, "fixtures",
                             "creditnote-invalid-typecode_ubl.xml")
MULTI_RULES = ("BR-CL-01", "BR-DE-17", "BR-DE-21")
MULTI_FATAL_RULE = "BR-CL-01"

# WARN: a warning-only fixture (0 fatal). This is the ONLY kind where the
#   --fail-on exit code genuinely differs: 0 by default (== --fail-on fatal),
#   1 under --fail-on warning/information. Reused verbatim from test_fail_on.py.
WARN_FIXTURE = os.path.join(HERE, "corpus", "cen-en16931", "test", "testfiles",
                            "BIS_Billing_30-Resor_Bokning.xml")
WARN_RULES = ("BR-DE-21",)

PROFILE = "xrechnung"


class _Cap:
    """Run ``fn(argv)`` capturing stdout, stderr and the return code.

    ``fn`` is ``einvoice.cli.main`` or ``einvoice.report.main`` — both take an
    argv list and RETURN the process exit code (they never sys.exit), exactly as
    ``test_fail_on.py``'s ``_Capture`` relies on for cli.main.
    """

    def __init__(self, fn, argv):
        self.fn = fn
        self.argv = list(argv)
        self.rc = None
        self.out = ""
        self.err = ""

    def __enter__(self):
        self._out, self._err = sys.stdout, sys.stderr
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
        try:
            self.rc = self.fn(self.argv)
        finally:
            self.out = sys.stdout.getvalue()
            self.err = sys.stderr.getvalue()
            sys.stdout, sys.stderr = self._out, self._err
        return self

    def __exit__(self, *exc):
        return False


def _machine_body(fmt, fixture):
    """The bytes ``einvoice.report --format <fmt>`` emits for a fixture.

    This is the auditor-facing machine artifact. It is produced WITHOUT any
    --fail-on flag because the machine surface has none (see
    MachineSurfaceHasNoFailOnKnob) — which is precisely why --fail-on cannot
    alter it.
    """
    with _Cap(report_main, ["--profile", PROFILE, "--format", fmt, fixture]) as c:
        return c.rc, c.out


def _validate_exit(fixture, fail_on=None):
    """Exit code of the ``einvoice validate`` CI gate, with/without --fail-on."""
    argv = ["validate", "--profile=" + PROFILE]
    if fail_on is not None:
        argv += ["--fail-on", fail_on]
    argv.append(fixture)
    with _Cap(cli_main, argv) as c:
        return c.rc


class FixturesPresent(unittest.TestCase):
    def test_fixtures_committed_and_present(self):
        for f in (MULTI_FIXTURE, WARN_FIXTURE):
            self.assertTrue(os.path.isfile(f), f)


class MachineSurfaceHasNoFailOnKnob(unittest.TestCase):
    """``einvoice.report`` (the ONLY machine-format emitter) has no --fail-on:
    passing it is a usage error, emitting NO body. This is the structural proof
    that --fail-on cannot drop/filter/re-level a machine finding — it is not a
    knob on this surface. If a future change wires --fail-on into the machine
    emitter, this trips so the invariance can be re-reviewed."""

    def test_report_rejects_fail_on_for_every_format(self):
        for fmt in MACHINE_FORMATS:
            with _Cap(report_main,
                      ["--profile", PROFILE, "--format", fmt,
                       "--fail-on", "warning", MULTI_FIXTURE]) as c:
                self.assertNotEqual(c.rc, EXIT_OK,
                                    "%s: --fail-on unexpectedly accepted" % fmt)
                self.assertEqual(c.out, "",
                                 "%s: rejected run still wrote a body" % fmt)
                self.assertIn("usage:", c.err, fmt)


class MachineBodyInvariantUnderFailOn(unittest.TestCase):
    """Criterion core: each machine-format body is BYTE-IDENTICAL with vs
    without --fail-on, and every finding stays present at its true severity."""

    def test_json_body_identical_with_and_without_failon(self):
        # json IS a machine format AND cli.py's validate takes --fail-on, so
        # this leg drives --fail-on DIRECTLY on a machine body: the payload
        # bytes are identical with `--fail-on fatal`/`information` and with no
        # flag, on both a fatal fixture and a warning fixture.
        for fixture in (MULTI_FIXTURE, WARN_FIXTURE):
            bodies = []
            for flag in (None, "fatal", "warning", "information"):
                argv = ["validate", "--json", "--profile=" + PROFILE]
                if flag is not None:
                    argv += ["--fail-on", flag]
                argv.append(fixture)
                with _Cap(cli_main, argv) as c:
                    bodies.append(c.out)
            for other in bodies[1:]:
                self.assertEqual(bodies[0], other,
                                 "json body drifted under --fail-on: %s"
                                 % fixture)

    def test_sarif_gitlab_junit_bodies_identical_across_failon_gate(self):
        # For sarif/gitlab/junit/github/azure: the emitted body is byte-
        # identical whether or not the pipeline ALSO runs the `einvoice
        # validate` gate under --fail-on. The machine artifact command carries
        # no --fail-on (the surface has none), so toggling the gate cannot move
        # a byte. We prove that by emitting the body in the WITHOUT-gate and
        # WITH-gate pipeline scenarios and comparing, per format, per fixture.
        for fixture, expect_rules in ((MULTI_FIXTURE, MULTI_RULES),
                                      (WARN_FIXTURE, WARN_RULES)):
            for fmt in MACHINE_FORMATS:
                # Scenario A: pipeline runs the gate WITHOUT --fail-on.
                _validate_exit(fixture, fail_on=None)
                rc_a, body_without_failon = _machine_body(fmt, fixture)
                # Scenario B: pipeline runs the gate WITH --fail-on.
                _validate_exit(fixture, fail_on="information")
                rc_b, body_with_failon = _machine_body(fmt, fixture)

                self.assertEqual(body_without_failon, body_with_failon,
                                 "%s body changed when --fail-on toggled on %s"
                                 % (fmt, os.path.basename(fixture)))
                self.assertEqual(rc_a, rc_b, "%s emit rc drift" % fmt)
                # Auditor still sees EVERY violation, whatever --fail-on does.
                for rule in expect_rules:
                    self.assertIn(rule, body_with_failon,
                                  "%s dropped %s on %s"
                                  % (fmt, rule, os.path.basename(fixture)))

    def test_fatal_finding_never_dropped_from_any_machine_format(self):
        # The strongest "never filtered" statement: the FATAL rule is present in
        # every machine body — the exit gate can fail CI on it, but it is never
        # hidden from the report an auditor reads.
        for fmt in MACHINE_FORMATS:
            _rc, body = _machine_body(fmt, MULTI_FIXTURE)
            self.assertIn(MULTI_FATAL_RULE, body,
                          "%s omitted the fatal %s" % (fmt, MULTI_FATAL_RULE))


class FailOnGatesExitCodeOnly(unittest.TestCase):
    """--fail-on moves the EXIT CODE and nothing else."""

    def test_exit_differs_but_machine_body_unchanged(self):
        # Warning-only fixture: the exit code genuinely DIFFERS across the
        # with/without --fail-on runs (0 by default -> 1 under --fail-on
        # warning), yet every machine body is byte-identical.
        rc_without = _validate_exit(WARN_FIXTURE, fail_on=None)
        rc_with = _validate_exit(WARN_FIXTURE, fail_on="warning")
        self.assertEqual(rc_without, EXIT_OK)
        self.assertEqual(rc_with, EXIT_FAIL)
        self.assertNotEqual(rc_without, rc_with,
                            "--fail-on failed to move the exit code")

        for fmt in MACHINE_FORMATS:
            rc0, body0 = _machine_body(fmt, WARN_FIXTURE)
            rc1, body1 = _machine_body(fmt, WARN_FIXTURE)
            self.assertEqual(body0, body1,
                             "%s body not stable while exit gate flipped" % fmt)
            self.assertEqual(rc0, EXIT_OK, fmt)  # no fatal -> machine emit is 0

    def test_fatal_fixture_exit_is_constant_body_keeps_all_findings(self):
        # A fatal finding crosses EVERY threshold, so on a fatal fixture the
        # exit code is constant 1 with AND without --fail-on (this is why the
        # exit-differs proof above uses a warning-only fixture instead). The
        # machine body meanwhile carries the fatal AND both warnings.
        rc_without = _validate_exit(MULTI_FIXTURE, fail_on=None)
        rc_with_fatal = _validate_exit(MULTI_FIXTURE, fail_on="fatal")
        rc_with_info = _validate_exit(MULTI_FIXTURE, fail_on="information")
        self.assertEqual(rc_without, EXIT_FAIL)
        self.assertEqual(rc_with_fatal, EXIT_FAIL)
        self.assertEqual(rc_with_info, EXIT_FAIL)

        for fmt in MACHINE_FORMATS:
            _rc, body = _machine_body(fmt, MULTI_FIXTURE)
            for rule in MULTI_RULES:
                self.assertIn(rule, body, "%s dropped %s" % (fmt, rule))


if __name__ == "__main__":
    unittest.main()

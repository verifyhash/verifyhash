#!/usr/bin/env python3
"""test_seam_determinism.py — T-VHSEAM.2: extend the CROSS-PROCESS byte-identity
proof to the three newest CLI/emit surfaces (receipt / attestation build /
--show-config).

MEASURE-FIRST FINDINGS (what the sibling tests already pin, read 2026-07-18)
----------------------------------------------------------------------------
* ``test_idempotence.py`` (``test_output_stable_across_processes_and_hash_seeds``,
  ~line 332) is the ONLY existing cross-PROCESS hash-seed proof, and it covers
  EXACTLY ONE surface: the ``validate`` report (``python3 -m einvoice.report``)
  under PYTHONHASHSEED 0 vs 1. It does NOT touch ``receipt``, the attestation
  build/emit path, or ``--show-config``.
* ``test_determinism.py`` pins byte-reproducibility of the committed GENERATED
  ARTIFACTS (each ``gen_*.py`` regenerated into a temp copy must byte-match the
  committed file) — a DIFFERENT thing (in-process regen equality, not a
  two-process differing-hash-seed stdout compare of a live CLI surface).
* Per-surface sibling suites pin OTHER properties but not this cross-process,
  differing-hash-seed one:
    - ``test_receipt.py`` (``test_two_cli_processes_are_byte_identical``) runs
      two ``receipt`` subprocesses but under the SAME (inherited) hash seed;
    - ``test_attestation.py`` (``test_regenerates_byte_identically`` /
      ``test_regeneration_is_stable_across_two_runs``) checks the attestation
      build/emit path IN-PROCESS only (``gen_attestation.attestation_json()``);
    - ``test_show_config.py`` drives ``--show-config`` IN-PROCESS via
      ``einvoice.cli.main`` (one interpreter), never two processes under
      differing PYTHONHASHSEED.
  So none of the three surfaces was cross-process hash-seed-pinned; that is the
  gap this file closes. (Nothing to verify-and-close: every leg was genuinely
  missing.)

WHAT THIS FILE BINDS
--------------------
For a fixed committed golden fixture, each of the three surfaces is driven as
TWO INDEPENDENT SUBPROCESSES — one under ``PYTHONHASHSEED=0`` and one under
``PYTHONHASHSEED=1`` (the same seed-pair pattern used in test_idempotence.py) —
and the stdout BYTES plus the exit code must be IDENTICAL across the two seeds.
If any set/dict-iteration order leaked into a rendered surface, the two seeds
would (eventually) disagree; by construction they must not.

The three surfaces and their exact invocations (discovered from the sibling
suites + cli.py):
  * ``receipt``     — ``einvoice.py receipt <fixture>``, the exact argv
                      test_receipt.py drives (WRAPPER + PASS_INVOICE). Emits the
                      canonical receipt JSON to stdout, exit 0 (PASS invoice).
  * ``attest``      — the attestation build/EMIT path, invoked exactly as
                      test_attestation.py's byte-reproducibility test does:
                      ``gen_attestation.attestation_json()``. Driven here in a
                      subprocess that writes that string to stdout (so we can
                      byte-compare) — it does NOT call ``gen_attestation.main``,
                      which would rewrite the committed attestation.json; this is
                      a read-only proof, the committed file is never touched.
  * ``--show-config`` — ``einvoice.py --show-config`` (cli.py:654 ->
                      _run_show_config, cli.py:451): the read-only config dry run,
                      exit 0, no input file read.

STRICT: zero behavior change — no source file is modified. This is a read-only
determinism proof over existing code paths. MEASURED OUTCOME (2026-07-18, before
this file was written): all three surfaces were already byte-identical across
the two seeds with equal exit codes; ZERO nondeterminism was found, so NO source
was modified — this file simply pins the already-true property.

Standard library only (subprocess/os/sys/unittest); zero new runtime deps —
test_packaging.py stays green. Offline, saxonche-free, runs in a few seconds.
"""

import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# Reuse test_receipt.py's exact receipt invocation + committed fixture (the
# source-checkout wrapper and the known-good PASS invoice) — no duplicated fixture
# path, no drift if the corpus anchor moves.
from test_receipt import WRAPPER, PASS_INVOICE  # noqa: E402

# The two differing hash seeds, matching the pair in test_idempotence.py.
SEEDS = ("0", "1")

# The attestation build/emit path, invoked EXACTLY as test_attestation.py's
# byte-reproducibility test does (``gen_attestation.attestation_json()``), but
# written to stdout so two processes can be byte-compared. Deliberately NOT
# ``gen_attestation.main()`` (which rewrites the committed attestation.json) —
# this is a read-only proof.
_ATTEST_EMIT = (
    "import gen_attestation, sys; "
    "sys.stdout.write(gen_attestation.attestation_json())"
)


def _run_two_seeds(cmd):
    """Run ``cmd`` (an argv list) twice — once per hash seed — from ``HERE`` and
    return a list of ``(returncode, stdout_bytes, stderr_bytes)`` in seed order.

    Only ``PYTHONHASHSEED`` differs between the two runs; everything else (argv,
    cwd, the rest of the environment) is held identical, so any stdout byte
    difference can only come from hash-seed-dependent iteration order."""
    results = []
    for seed in SEEDS:
        env = dict(os.environ, PYTHONHASHSEED=seed)
        proc = subprocess.run(
            cmd, cwd=HERE, capture_output=True, env=env, timeout=180)
        results.append((proc.returncode, proc.stdout, proc.stderr))
    return results

class SeamCrossProcessDeterminism(unittest.TestCase):
    """Each newest surface emits byte-identical stdout + equal exit code when run
    as two independent subprocesses under PYTHONHASHSEED=0 and =1."""

    def _assert_identical_across_seeds(self, cmd, want_code, must_contain=None):
        results = _run_two_seeds(cmd)
        (code0, out0, err0), (code1, out1, err1) = results
        # Non-vacuous: the surface actually produced output and the expected code.
        self.assertEqual(code0, want_code,
                         "seed 0: unexpected exit %d for %r\nstderr=%r"
                         % (code0, cmd, err0))
        self.assertEqual(code1, want_code,
                         "seed 1: unexpected exit %d for %r\nstderr=%r"
                         % (code1, cmd, err1))
        self.assertTrue(out0, "empty stdout for %r under seed 0" % (cmd,))
        # The two seeds must agree on BOTH the exit code and the stdout bytes.
        self.assertEqual(code0, code1,
                         "exit code differs across hash seeds for %r" % (cmd,))
        self.assertEqual(
            out0, out1,
            "stdout bytes differ across PYTHONHASHSEED 0/1 for %r" % (cmd,))
        if must_contain is not None:
            self.assertIn(must_contain, out0)
        return out0

    def test_receipt_identical_across_hash_seeds(self):
        """``einvoice receipt <fixture>`` (the exact argv test_receipt.py drives)
        emits a byte-identical canonical receipt JSON, exit 0, across the two
        seeds."""
        self._assert_identical_across_seeds(
            [sys.executable, WRAPPER, "receipt", PASS_INVOICE],
            want_code=0,
            must_contain=b"content_sha256")

    def test_attest_build_emit_identical_across_hash_seeds(self):
        """The attestation build/emit path (``gen_attestation.attestation_json``,
        exactly as test_attestation.py invokes it) emits byte-identical stdout,
        exit 0, across the two seeds — and never rewrites the committed
        attestation.json."""
        self._assert_identical_across_seeds(
            [sys.executable, "-c", _ATTEST_EMIT],
            want_code=0,
            must_contain=b"content_sha256")

    def test_show_config_identical_across_hash_seeds(self):
        """``einvoice --show-config`` (the read-only config dry run) emits
        byte-identical stdout, exit 0, across the two seeds."""
        self._assert_identical_across_seeds(
            [sys.executable, WRAPPER, "--show-config"],
            want_code=0,
            must_contain=b"format:")

    def test_committed_attestation_untouched_by_the_emit_probe(self):
        """Guard: the attest leg drives the EMIT path (attestation_json -> stdout),
        never gen_attestation.main, so the committed attestation.json is not
        rewritten by running this test. Its bytes before and after an emit are
        identical."""
        att = os.path.join(HERE, "attestation.json")
        with open(att, "rb") as fh:
            before = fh.read()
        _run_two_seeds([sys.executable, "-c", _ATTEST_EMIT])
        with open(att, "rb") as fh:
            after = fh.read()
        self.assertEqual(before, after,
                         "the emit probe must not rewrite attestation.json")


if __name__ == "__main__":
    unittest.main(verbosity=2)

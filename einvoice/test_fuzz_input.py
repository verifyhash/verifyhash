#!/usr/bin/env python3
"""test_fuzz_input.py — seeded byte/structural input-mutation fuzz.

Real supplier intake feeds this validator arbitrary garbage. The product
promise for such input is narrow and absolute: **the validate pipeline is
TOTAL** — for ANY byte sequence it must not crash, must not hang, and must
always land on a documented exit code, returning a real Result/report rather
than letting an exception escape.

Where the ``test_robustness*.py`` suites pin a handful of hand-ENUMERATED
malformed shapes (empty file, wrong root, truncated XML, a duplicated block),
this suite is DISJOINT: it generates a large, deterministic POPULATION of
mutations off the committed valid golden fixture to catch the UNKNOWN shape
nobody thought to enumerate. It is the first task of the EPIC-VHFUZZ lane.

It changes NO parser / rule / report source — it lands purely as a property /
regression guard, and it must NEVER loosen a real rule to accept garbage: a
genuinely-unsupported shape must surface a clean actionable error or a
documented exit code, never a silent pass and never a crash.

What the suite pins:

  * DETERMINISM (the reproduce-yourself foundation): every mutated blob is
    drawn from a FIXED-``SEED`` :class:`random.Random`, so the whole population
    is byte-for-byte reproducible. An explicit assertion builds the population
    twice from two freshly-seeded generators and requires the two blob lists to
    be IDENTICAL.

  * A MIX of >=6 mutation strategies (single/multi byte flip, byte deletion,
    byte insertion, truncation at a random offset, duplication of a random
    byte-range, and XML-structure corruption of a random ``<...>`` tag), with
    strategy selection and every offset driven ONLY by ``rng``.

  * TOTALITY at BOTH boundaries the product exposes:
      (i)  in-process ``report.build_report`` on every blob — any uncaught
           exception FAILS the test (the pipeline must handle its own errors and
           return a report, never let an exception escape);
      (ii) a deterministic SUBSET through the real process boundary,
           ``einvoice.py validate <file>`` via ``subprocess.run``, pinning the
           SAME three-legged contract as ``test_robustness_malformed.py``:
             - exit code ALWAYS a member of the documented set {0,1,2,3}
               (EXIT_OK / EXIT_FAIL / EXIT_USAGE / EXIT_PARSE, see EXIT-CODES.md)
               — membership only, never a specific value, since the mutation is
               random;
             - NO ``Traceback (most recent call last)`` in stdout OR stderr;
             - a per-case wall-clock timeout whose ``TimeoutExpired`` FAILS the
               test (proving no hang) rather than blocking the suite.

No new fixture is committed: every input is derived at runtime from the already
committed golden ``corpus/synthetic/synth-ubl-good-xrechnung.xml``. Standard
library only. Runs offline. Run: python3 test_fuzz_input.py
"""

from __future__ import annotations

import os
import random
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# Symbolic exit codes come from the shipped CLI module so this test pins the
# SAME numbers EXIT-CODES.md documents (0/1/2/3), never hand-copied literals.
from einvoice.cli import (  # noqa: E402
    EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE,
)
from einvoice import report as _report  # noqa: E402

CLI = os.path.join(HERE, "einvoice.py")
GOLDEN = os.path.join(
    HERE, "corpus", "synthetic", "synth-ubl-good-xrechnung.xml")

TRACEBACK_MARK = "Traceback (most recent call last)"

# The documented exit-code set (EXIT-CODES.md). A random mutation may land on
# ANY of these; membership is the contract, never a specific value.
DOCUMENTED_EXITS = frozenset({EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE})

# Fixed integer seed => the ENTIRE mutation population is byte-for-byte
# reproducible run to run. Change it and you get a different (still fixed) draw.
SEED = 0xF0221A7

# Population size and the subprocess-boundary subset size. 240 > the required
# 200; 40 > the required ~30. Both driven off the fixed seed.
N_MUTATIONS = 240
N_SUBPROCESS = 40

# Per-case wall-clock ceiling for the real process boundary. A legitimate run
# finishes in well under a second; a real hang / unbounded expansion blows past
# this and raises TimeoutExpired, which the harness turns into a FAILURE (never
# a blocked suite). Generous enough to survive a loaded CI box.
CASE_TIMEOUT_S = 20.0

# Human-readable strategy tags, indexed by the strategy selector below.
STRATEGIES = (
    "byte-flip",
    "byte-delete",
    "byte-insert",
    "truncate",
    "range-duplicate",
    "tag-corrupt",
)


def _load_golden_bytes():
    """Read the committed golden UBL invoice as raw bytes (the derivation base)."""
    with open(GOLDEN, "rb") as fh:
        return fh.read()


def _mutate_once(rng, base):
    """Produce ONE mutated blob from ``base`` (bytes), driven entirely by ``rng``.

    Returns ``(blob_bytes, strategy_tag)``. Strategy selection and every offset
    come from ``rng`` alone, so for a fixed seed the whole sequence is fixed.
    """
    n = len(base)
    strat = rng.randrange(len(STRATEGIES))
    buf = bytearray(base)

    if strat == 0:
        # (a) single/multi random byte flip: XOR k random positions with a
        # random non-zero byte so the value genuinely changes.
        k = rng.randint(1, 8)
        for _ in range(k):
            pos = rng.randrange(n)
            buf[pos] ^= rng.randint(1, 255)

    elif strat == 1:
        # (b) random byte deletion (of a short run).
        k = rng.randint(1, 8)
        for _ in range(k):
            if len(buf) <= 1:
                break
            del buf[rng.randrange(len(buf))]

    elif strat == 2:
        # (c) random byte insertion (of a short run of random bytes).
        k = rng.randint(1, 8)
        for _ in range(k):
            pos = rng.randrange(len(buf) + 1)
            buf.insert(pos, rng.randint(0, 255))

    elif strat == 3:
        # (d) truncation at a random offset (may leave an unclosed document,
        # zero bytes, or almost the whole thing).
        cut = rng.randrange(n + 1)
        buf = bytearray(base[:cut])

    elif strat == 4:
        # (e) duplication of a random byte-range spliced back in at a random
        # offset (grows the document, can unbalance structure).
        a = rng.randrange(n)
        b = rng.randint(a + 1, n)
        chunk = base[a:b]
        pos = rng.randrange(len(buf) + 1)
        buf[pos:pos] = chunk

    else:
        # (f) target XML structure: corrupt or delete a random <...> tag or a
        # lone angle bracket. Falls back to a byte flip if no bracket exists.
        lt_positions = [i for i, c in enumerate(base) if c == 0x3C]  # '<'
        if not lt_positions:
            pos = rng.randrange(n)
            buf[pos] ^= rng.randint(1, 255)
        else:
            start = rng.choice(lt_positions)
            gt = base.find(0x3E, start)  # matching '>'
            action = rng.randrange(3)
            if gt == -1 or action == 0:
                # Corrupt the opening bracket into a letter so the element
                # boundary is destroyed but bytes stay printable.
                buf[start] = rng.choice(b"xYz09_ ")
            elif action == 1:
                # Delete the whole <...> tag, collapsing its element boundary.
                del buf[start:gt + 1]
            else:
                # Delete just the closing '>' so the tag never terminates.
                del buf[gt]

    return bytes(buf), STRATEGIES[strat]


def _generate_population(seed, base, count):
    """Build the FIXED mutation population from a freshly-seeded generator.

    Returns a list of ``(blob_bytes, strategy_tag)``. Called with the SAME
    (seed, base, count) it returns byte-for-byte identical results — that is the
    determinism the reproducibility assertion checks.
    """
    rng = random.Random(seed)
    return [_mutate_once(rng, base) for _ in range(count)]


# Build the population ONCE at import so every test shares the same fixed draw.
_BASE = _load_golden_bytes()
_POPULATION = _generate_population(SEED, _BASE, N_MUTATIONS)

# Deterministically choose the subprocess-boundary subset from a SEPARATE
# fixed generator so it never perturbs the population draw above.
_SUBSET_INDICES = tuple(sorted(
    random.Random(SEED ^ 0x5EED).sample(range(N_MUTATIONS), N_SUBPROCESS)))


class FuzzBase(unittest.TestCase):
    """Shared helpers: write a blob to a temp .xml and drive each boundary."""

    def _build_report_on(self, blob):
        """Run ``report.build_report`` on ``blob`` in-process, returning the report.

        Any uncaught exception is a TOTALITY failure: the pipeline must fold its
        own errors into a report, never let them escape.
        """
        fd, path = tempfile.mkstemp(suffix=".xml", prefix="einvoice-fuzz-")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(blob)
            return _report.build_report(path, profile="xrechnung")
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

    def _run_validate(self, blob):
        """Drive the shipped CLI at the real process boundary on ``blob``.

        A per-case timeout turns a hang into a test FAILURE rather than a
        blocked suite. Returns ``(returncode, stdout, stderr)``.
        """
        fd, path = tempfile.mkstemp(suffix=".xml", prefix="einvoice-fuzz-")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(blob)
            try:
                proc = subprocess.run(
                    [sys.executable, CLI, "validate", path],
                    capture_output=True, text=True, timeout=CASE_TIMEOUT_S)
            except subprocess.TimeoutExpired:
                self.fail(
                    "CLI hung > %.0fs on a fuzzed input — a hang is a TOTALITY "
                    "FAILURE, not an acceptable outcome" % CASE_TIMEOUT_S)
            return proc.returncode, proc.stdout, proc.stderr
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass


class TestFixtureAndSetup(FuzzBase):
    def test_golden_fixture_and_cli_present(self):
        self.assertTrue(os.path.isfile(GOLDEN),
                        "golden derivation fixture missing: %s" % GOLDEN)
        self.assertTrue(os.path.isfile(CLI), "shipped CLI missing: %s" % CLI)
        self.assertGreater(len(_BASE), 1000,
                           "golden base unexpectedly small; derivation is weak")

    def test_golden_base_is_a_real_pass(self):
        """Control: the un-mutated golden base validates cleanly (valid=True).

        Proves the mutated cases stress the pipeline *because of the mutation*,
        not because the base document was already broken.
        """
        rep = self._build_report_on(_BASE)
        self.assertIsInstance(rep, dict)
        self.assertTrue(rep.get("valid"),
                        "golden base is not a clean pass: %r"
                        % {k: rep.get(k) for k in ("valid", "error")})

    def test_documented_exit_symbols(self):
        # Guards against an accidental repurposing of a documented code.
        self.assertEqual(
            (EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE), (0, 1, 2, 3))
        self.assertEqual(DOCUMENTED_EXITS, {0, 1, 2, 3})


class TestPopulationIsReproducible(FuzzBase):
    """The determinism leg: a fixed SEED yields a byte-for-byte fixed population."""

    def test_two_seeded_generations_are_identical(self):
        first = _generate_population(SEED, _BASE, N_MUTATIONS)
        second = _generate_population(SEED, _BASE, N_MUTATIONS)
        self.assertEqual(
            [blob for blob, _ in first],
            [blob for blob, _ in second],
            "mutation population is NOT reproducible for a fixed seed — the "
            "reproduce-yourself foundation is broken")
        # And it matches the population the whole suite actually exercises.
        self.assertEqual([blob for blob, _ in first],
                         [blob for blob, _ in _POPULATION])

    def test_population_size_and_strategy_coverage(self):
        self.assertGreaterEqual(
            len(_POPULATION), 200,
            "need >=200 mutated blobs, have %d" % len(_POPULATION))
        seen = {tag for _, tag in _POPULATION}
        self.assertGreaterEqual(
            len(seen), 5,
            "need >=5 distinct mutation strategies, saw %r" % sorted(seen))
        # The angle-bracket structural strategy in particular must be present —
        # it is the one that probes XML shape, not just bytes.
        self.assertIn("tag-corrupt", seen,
                      "structural (tag) mutation strategy never fired")


class TestInProcessTotality(FuzzBase):
    """Every blob through ``report.build_report`` — no uncaught exception may escape."""

    def test_build_report_never_raises(self):
        failures = []
        for idx, (blob, tag) in enumerate(_POPULATION):
            try:
                rep = self._build_report_on(blob)
            except Exception as exc:  # noqa: BLE001 — the whole point is to catch ANY
                failures.append(
                    "blob #%d (%s, %d bytes): build_report raised %s: %s"
                    % (idx, tag, len(blob), type(exc).__name__, exc))
                continue
            # A report must come back as a dict carrying the 'valid' verdict; a
            # None / non-dict return would be a silent contract break.
            if not isinstance(rep, dict) or "valid" not in rep:
                failures.append(
                    "blob #%d (%s): build_report returned a non-report %r"
                    % (idx, tag, type(rep).__name__))
        self.assertEqual(
            failures, [],
            "build_report is NOT total over fuzzed input:\n" + "\n".join(failures[:20]))


class TestProcessBoundaryContract(FuzzBase):
    """The subset through the real ``einvoice.py validate`` process boundary."""

    def test_subset_honours_the_three_legged_contract(self):
        self.assertGreaterEqual(
            len(_SUBSET_INDICES), 30,
            "need >=30 subprocess cases, have %d" % len(_SUBSET_INDICES))
        bad_exit = []
        traceback_leak = []
        for idx in _SUBSET_INDICES:
            blob, tag = _POPULATION[idx]
            rc, out, err = self._run_validate(blob)  # timeout -> self.fail (no hang)
            if rc not in DOCUMENTED_EXITS:
                bad_exit.append(
                    "blob #%d (%s): undocumented exit %r (not in %s)"
                    % (idx, tag, rc, sorted(DOCUMENTED_EXITS)))
            if TRACEBACK_MARK in out or TRACEBACK_MARK in err:
                traceback_leak.append(
                    "blob #%d (%s): leaked a Python traceback\nstdout=%r\nstderr=%r"
                    % (idx, tag, out[-500:], err[-500:]))
        self.assertEqual(
            bad_exit, [],
            "process boundary produced undocumented exit codes:\n"
            + "\n".join(bad_exit))
        self.assertEqual(
            traceback_leak, [],
            "process boundary leaked a traceback (crash, not clean-error):\n"
            + "\n".join(traceback_leak[:10]))


if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if result.wasSuccessful():
        print("OK: %d mutations, seed=%d" % (N_MUTATIONS, SEED))
        sys.exit(0)
    sys.exit(1)

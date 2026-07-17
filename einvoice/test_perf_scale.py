#!/usr/bin/env python3
"""Machine-independent perf regression guard for the einvoice engine.

THE ONE BOUND (relative, never absolute)
----------------------------------------
Validating an invoice must not get more expensive as the batch grows: for
each measured series (UBL single path, CII single path, public batch path)
the per-invoice wall-time at N=1000 must stay within a generous constant
factor (<= 3x) of the per-invoice wall-time at N=100. That catches the
real regression classes — accidental O(n^2) aggregation, per-file re-parse
of a shared catalog that should be cached across a batch, state that
accumulates per validated file — while pinning NO absolute ms or RSS
budget, so the test is machine-independent by construction and cannot go
red just because the box is slower than the author's.

NOISE TOLERANCE
---------------
The N=100 baseline is the median of 3 full repetitions (a scheduler blip
in one rep cannot drag the baseline down), and each per-invoice number at
N=100/N=1000 is already an average over 100/1000 validations, so
single-validation jitter is averaged out before the ratio is taken. The
3x allowance on top is deliberately generous: genuinely linear behaviour
measures ~1.0x here; a real O(n^2) slip at this size shows up as ~10x.

Measurement machinery is imported from bench_scale.py (same synthesized
valid fixtures, same warmed-up code paths, same median-of-reps timing) —
this file adds only the relative assertion. Runs standalone:

    python3 test_perf_scale.py      (exit 0 = pass, non-zero = fail)

Standard library only. No absolute wall-time or RSS assertion anywhere.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bench_scale  # noqa: E402

BASE_N = 100
BIG_N = 1000
MAX_RATIO = 3.0  # generous: linear ~= 1.0x, O(n^2) at this size ~= 10x


def _reps(n):
    """Median-of-3 at the (noise-prone) N=100 baseline, one pass at N=1000."""
    return 3 if n <= BASE_N else 1


def main():
    summary = bench_scale.run(sizes=(BASE_N, BIG_N), reps_for=_reps)
    failures = []
    for name in ("ubl_single", "cii_single", "batch"):
        series = summary["series"][name]
        base = series[str(BASE_N)]["per_invoice_ms"]
        big = series[str(BIG_N)]["per_invoice_ms"]
        if base <= 0:
            failures.append("%s: nonsensical baseline %r ms at N=%d"
                            % (name, base, BASE_N))
            continue
        ratio = big / base
        verdict = "PASS" if ratio <= MAX_RATIO else "FAIL"
        print("%s %-11s per-invoice N=%d: %.4f ms | N=%d: %.4f ms | "
              "ratio %.3fx (bound <= %.1fx)"
              % (verdict, name, BASE_N, base, BIG_N, big, ratio, MAX_RATIO))
        if ratio > MAX_RATIO:
            failures.append(
                "%s: per-invoice cost at N=%d is %.3fx the N=%d cost "
                "(bound %.1fx) — scaling regression (O(n^2) growth or "
                "per-file re-parse?)"
                % (name, BIG_N, ratio, BASE_N, MAX_RATIO))
    if failures:
        for f in failures:
            print("FAIL:", f, file=sys.stderr)
        print("test_perf_scale: %d failure(s)" % len(failures),
              file=sys.stderr)
        return 1
    print("test_perf_scale: all %d series scale linearly "
          "(N=%d vs N=%d, bound %.1fx) — OK"
          % (3, BIG_N, BASE_N, MAX_RATIO))
    return 0


if __name__ == "__main__":
    sys.exit(main())

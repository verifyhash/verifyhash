#!/usr/bin/env python3
"""Corpus-wide machine-format COVERAGE-COMPLETENESS invariant + byte-stability
re-emit guard (T-VHFMTP.6).

WHAT THIS IS
------------
``test_format_regression.py`` freezes the EXACT emitted bytes of each registered
machine/CI format (json/junit/sarif/gitlab/github/azure) for a curated list of
economically-distinct fixtures and fails on any drift. That is a per-fixture
CONTENT lock. It does NOT, however, answer two structural questions:

  1. COMPLETENESS — "has every economically-distinct synthetic corpus fixture
     that we already pin a normalized projection for actually grown its FULL
     six-format machine golden set, or did one slip through with, say, a sarif
     and gitlab golden but no azure?" A half-covered fixture would still let
     ``test_format_regression`` pass green (it only checks the goldens it lists),
     so a genuine coverage hole could hide indefinitely. This module LOCKS the
     closed state: every projection-pinned ``corpus/synthetic/synth-*.xml``
     fixture must carry a golden for EVERY machine format, or the run goes red
     naming the exact fixture + missing format. A fixture that is deliberately
     left machine-uncovered must be declared, with a reason, in the explicit
     ``KNOWN_NO_MACHINE_GOLDEN`` allowlist — an undeclared gap fails.

  2. DETERMINISM — "is each emitter idempotent, i.e. does emitting the SAME
     report dict twice yield byte-identical output?" If any machine serializer
     leaked set/dict-ordering or a timestamp into its bytes, two back-to-back
     emits of one report would differ, and the frozen golden would be a coin
     toss. This module proves byte-stability for every (fixture, format) pair.

Both guards REUSE ``test_format_regression``'s machinery verbatim (its
``FIXTURES``, ``MACHINE_FORMATS``, ``FORMAT_EXT``, ``build_report_dict`` and the
``emit`` helper) and ``test_golden_snapshot``'s pinned corpus. It adds no format,
changes no emitter, re-implements no rule logic and hand-authors no bytes — it
only asserts structural properties of goldens that already exist on disk.

MEASURE-FIRST
-------------
At plan time a ``comm -23`` over the tree confirmed all 25
``corpus/synthetic/synth-*.xml`` fixtures currently carry BOTH a projection
golden (``golden/<base>.json``) and a complete six-format machine golden set, so
this guard passes GREEN on the current tree; it locks that closed state rather
than papering over a gap. ``KNOWN_NO_MACHINE_GOLDEN`` is therefore empty today —
do NOT invent exclusions to force a pass; a real gap must be fixed (add the
missing golden via ``test_format_regression.py --update``) or, if genuinely out
of scope, declared here with an honest inline reason.

Standard library only. No network, no hardhat, no PDF regeneration beyond what
``emit`` already drives. Runs in well under a second.
"""

from __future__ import annotations

import glob
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# Reuse the EXACT regression machinery — no re-implementation, no hand-authored
# bytes. ``golden_path(name, fmt)`` yields golden/<name>.<FORMAT_EXT[fmt]>, the
# same machine-golden filename convention the regression lock writes.
from test_format_regression import (  # noqa: E402
    FIXTURES,
    FORMAT_EXT,
    GOLDEN_DIR,
    MACHINE_FORMATS,
    build_report_dict,
    emit,
    fx_profile,
    golden_path,
)
import test_golden_snapshot as _tgs  # noqa: E402

#: Glob for the economically-distinct synthetic corpus. Every hand-authored
#: real-shape synthetic invoice lives here as synth-<syntax>-<good|bad>-<case>.
CORPUS_GLOB = os.path.join(HERE, "corpus", "synthetic", "synth-*.xml")

#: The set of synthetic-corpus fixtures that carry a normalized PROJECTION
#: golden — i.e. are pinned in test_golden_snapshot.py's corpus. Keyed by the
#: fixture basename (minus .xml), which is exactly the golden stem. Only these
#: are REQUIRED to also carry a full machine golden set; a corpus file with no
#: projection pin is out of the completeness contract's scope (and must instead
#: be accounted for by the allowlist below).
PROJECTION_PINNED = frozenset(
    os.path.splitext(os.path.basename(fx.get("path", "")))[0]
    for fx in _tgs.FIXTURES
    if fx.get("path", "").startswith("corpus/synthetic/")
)

#: Corpus fixtures deliberately EXCLUDED from machine-golden coverage. Each key
#: MUST carry a concrete inline reason. EMPTY on the current tree: every
#: projection-pinned synthetic fixture has a complete six-format machine golden
#: set (verified measure-first). Add an entry ONLY for a real, justified
#: exclusion — never to silence a genuine gap (fix that by regenerating the
#: missing golden).
KNOWN_NO_MACHINE_GOLDEN = {
    # e.g. "synth-foo-bar": "reason this fixture is projection-pinned but "
    #                       "intentionally not byte-locked in machine formats",
}


def corpus_bases():
    """Sorted list of every ``corpus/synthetic/synth-*.xml`` basename (minus
    .xml). Uses HERE-anchored globbing so it is checkout-location independent."""
    return sorted(
        os.path.splitext(os.path.basename(p))[0]
        for p in glob.glob(CORPUS_GLOB)
    )


def check_completeness(failures):
    """PART A — assert every projection-pinned synthetic corpus fixture carries
    a COMPLETE machine golden set; any un-pinned, un-covered corpus fixture must
    be allowlisted. Appends precise, fixture+format-specific lines to
    ``failures``."""
    bases = corpus_bases()

    # (4) A broken glob must not vacuously pass.
    if len(bases) < 20:
        failures.append(
            "  CORPUS TOO SMALL: %r enumerated only %d fixture(s) (< 20) — a "
            "broken glob or moved corpus would let this invariant pass "
            "vacuously." % (os.path.relpath(CORPUS_GLOB, HERE), len(bases)))

    # Guard the allowlist itself against staleness: an entry that names a file
    # no longer in the corpus is a lie that must be cleaned up.
    corpus_set = set(bases)
    for stale in sorted(set(KNOWN_NO_MACHINE_GOLDEN) - corpus_set):
        failures.append(
            "  STALE ALLOWLIST: KNOWN_NO_MACHINE_GOLDEN names %r, which is not "
            "in corpus/synthetic anymore — remove it." % stale)

    for base in bases:
        if base in KNOWN_NO_MACHINE_GOLDEN:
            # Deliberately excluded with a documented reason: out of scope.
            continue
        if base in PROJECTION_PINNED:
            # (2) Projection-pinned -> require ALL six machine goldens on disk.
            for fmt in MACHINE_FORMATS:
                gpath = golden_path(base, fmt)
                if not os.path.isfile(gpath):
                    failures.append(
                        "  INCOMPLETE machine golden set: fixture %r is "
                        "projection-pinned but is MISSING its %s golden "
                        "(expected %s). Regenerate with "
                        "`python3 test_format_regression.py --update`."
                        % (base, fmt, os.path.relpath(gpath, HERE)))
        else:
            # (3) In corpus, not projection-pinned, not allowlisted: unexplained.
            failures.append(
                "  UNEXPLAINED gap: fixture %r is in corpus/synthetic but is "
                "neither projection-pinned (so machine-covered) nor listed in "
                "KNOWN_NO_MACHINE_GOLDEN with a reason." % base)


def check_byte_stability(failures):
    """PART B — for each (fixture, format) build the report dict ONCE, emit
    TWICE, and assert byte-identity. Proves each machine serializer is
    idempotent (no set/dict-ordering or timestamp nondeterminism leaks into the
    bytes). Reuses the SAME build+emit path as test_format_regression."""
    for fx in FIXTURES:
        rep = build_report_dict(fx["rel"], fx["kind"], fx_profile(fx))
        for fmt in MACHINE_FORMATS:
            first = emit(rep, fmt)
            second = emit(rep, fmt)
            if first != second:
                failures.append(
                    "  NONDETERMINISTIC emit: %s --format %s produced differing "
                    "bytes across two back-to-back emits of the SAME report "
                    "(%d vs %d bytes) — serialization is not idempotent."
                    % (fx["name"], fmt, len(first), len(second)))


def check(verbose=True):
    """Run both structural invariants. Returns (ok, failures)."""
    failures = []
    check_completeness(failures)
    check_byte_stability(failures)
    ok = not failures
    if verbose:
        if ok:
            sys.stdout.write(
                "OK: %d synthetic corpus fixture(s) fully machine-covered; "
                "%d (fixture,format) emit(s) byte-stable.\n"
                % (len(corpus_bases()), len(FIXTURES) * len(MACHINE_FORMATS)))
        else:
            sys.stdout.write("FAIL: %d completeness/determinism issue(s):\n"
                             % len(failures))
            for ln in failures:
                sys.stdout.write(ln + "\n")
    return ok, failures


def main(argv=None):
    ok, _ = check(verbose=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

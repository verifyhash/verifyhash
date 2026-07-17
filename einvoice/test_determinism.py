#!/usr/bin/env python3
"""test_determinism.py — ONE umbrella "regenerate everything, get byte-identical
committed artifacts" guard over every ``gen_*.py`` under ``einvoice/``.

Nine of the twelve generators already ship a per-artifact ``--check`` (a stale
gate you run by hand or in CI). Three did NOT — ``gen_attestation.py``,
``gen_export.py`` and ``gen_sb_fixtures.py`` — and, more importantly, there was
no single test proving the WHOLE committed generated surface is reproducible
from source. This is that test. It does not replace or weaken any existing
``--check``; it is a superset that also catches a brand-new generator silently
escaping the guard (see :func:`test_all_generators_covered`).

How it works (STEP 2). For each generator it makes a throwaway ``copytree`` of
the einvoice tree under a temp dir, runs the generator IN that copy exactly as a
developer would (``python3 gen_X.py``, no flags), and asserts the regenerated
bytes are byte-for-byte identical to the committed artifact(s). The committed
tree is never touched — every write lands in the temp copy, which is deleted
afterwards. Running in a pristine copy means each generator reads the *committed*
upstream artifacts (e.g. gen_attestation reads the committed rules.json /
coverage.json / bom.json), so a failure isolates to the generator under test.

Artifacts are matched by glob PATTERN (relative to this dir), expanded against
BOTH the committed tree and the regenerated tree; the two file SETS must be
equal. That way an ADDED or REMOVED artifact (not just drifted bytes) also
fails — e.g. a new rule that should have produced a new ``www/rules/<ID>/``
page, or a syntax-binding fixture that should have been pruned.

STEP 3 outcome (measured 2026-07-16 on HEAD 4a35ea5): every generator is
already deterministic — no dict/set-ordering, timestamp, absolute-path or
unsorted-glob leakage was found, and no committed artifact embeds a volatile
field, so NO generator needed a fix and NO artifact changed. The honest result
is this passing meta-test with zero source edits. If a future artifact
legitimately embeds ONE volatile field (a timestamp/version/abs-path), normalise
just that field in :meth:`_compare` rather than dropping the artifact from the
map — do not silently exclude it.

Standard library only (glob/os/shutil/subprocess/tempfile/unittest). No runtime
dependency is added; ``test_packaging.py`` still proves zero runtime deps.
"""

import glob
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------------------
# STEP 1 — enumerate every generator and the committed artifact(s) it writes.
#
# Keys are the generator module name WITHOUT the ``.py`` suffix (so the set of
# keys lines up directly with ``glob("gen_*.py")`` stripped of ``.py``). Values
# are lists of path patterns, RELATIVE to this directory, that the generator
# emits; a pattern may contain a shell glob (``*``) for the variable-cardinality
# generators (per-rule site pages, per-example reports, per-id fixtures) so that
# newly-added rules/examples/ids are covered automatically without editing this
# map.
# ---------------------------------------------------------------------------
GENERATORS = {
    # single- or fixed-set JSON/Markdown artifacts
    "gen_export": ["export/rules.json", "export/coverage.json"],
    "gen_attestation": ["attestation.json"],
    "gen_sbom": ["sbom/bom.json"],
    "gen_cii_parity": ["cii_parity.json"],
    "gen_coverage": ["coverage_matrix.json", "COVERAGE.md"],
    "gen_known_open_audit": ["known_open_audit.json"],
    "gen_remediation": ["remediation_catalog.json"],
    "gen_rules_doc": ["einvoice/RULES.md"],
    "gen_syntax_binding": ["syntax_binding_catalog.json"],
    "gen_testsuite_conformance": ["testsuite_conformance.json"],
    "gen_api_contract": ["api_contract.json"],
    # per-example JSON reports (one committed report.json per examples/<n>/)
    "gen_examples": ["examples/*/report.json"],
    # the static per-rule reference site: landing + hub + walkthrough +
    # licensing + sitemap + robots + one index.html per rule
    "gen_site": [
        "www/index.html",
        "www/robots.txt",
        "www/sitemap.xml",
        "www/rules/index.html",
        "www/rules/*/index.html",
        "www/walkthrough/index.html",
        "www/licensing/index.html",
    ],
    # synthesized syntax-binding violation fixtures: per-id UBL fixtures + the
    # CII clean base + per-id CII violation fixtures
    "gen_sb_fixtures": [
        "corpus/vendored/syntax-binding/sb-viol-*_ubl.xml",
        "fixtures/sb-pass-clean_cii.xml",
        "fixtures/sb-viol-*_cii.xml",
    ],
}

# Generators deliberately NOT byte-checked by the umbrella. Each entry MUST
# carry a one-line reason. Currently EMPTY — every generator on disk is
# byte-checked above. (If you ever add one here, document WHY it cannot be made
# deterministic rather than using this as an escape hatch.)
EXCLUDED = {
    # "gen_example": "reason it cannot be byte-checked",
}

# Every gen_*.py must run in seconds; give a generous ceiling so a pathological
# hang fails loudly instead of wedging the suite.
_RUN_TIMEOUT = 300


def _discover_generators():
    """Sorted list of gen_*.py basenames (without .py) present on disk."""
    return sorted(
        os.path.basename(p)[:-3]
        for p in glob.glob(os.path.join(HERE, "gen_*.py"))
    )


def _expand(root, patterns):
    """Map {relative-path: absolute-path} for every file under ``root``
    matching any of ``patterns``."""
    found = {}
    for pat in patterns:
        for abspath in glob.glob(os.path.join(root, pat)):
            if os.path.isfile(abspath):
                found[os.path.relpath(abspath, root)] = abspath
    return found


class DeterminismTest(unittest.TestCase):
    """Regenerate each generator into a temp copy; assert byte-identity."""

    def _fresh_tree(self):
        """A throwaway copytree of the einvoice dir (never the committed one).

        __pycache__/*.pyc are skipped — they are not inputs and only bloat the
        copy. The temp dir is registered for cleanup on test exit.
        """
        tmp = tempfile.mkdtemp(prefix="vh-determinism-")
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        dst = os.path.join(tmp, "einvoice")
        shutil.copytree(
            HERE, dst,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        return dst

    def _check_generator(self, gen, patterns):
        tree = self._fresh_tree()

        proc = subprocess.run(
            [sys.executable, gen + ".py"],
            cwd=tree,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=_RUN_TIMEOUT,
        )
        self.assertEqual(
            proc.returncode, 0,
            "%s.py exited %d\nSTDOUT:\n%s\nSTDERR:\n%s"
            % (gen, proc.returncode,
               proc.stdout.decode("utf-8", "replace"),
               proc.stderr.decode("utf-8", "replace")),
        )

        committed = _expand(HERE, patterns)
        regen = _expand(tree, patterns)

        # A typo'd pattern that matches nothing would make this test silently
        # vacuous — refuse that.
        self.assertTrue(
            committed,
            "%s: patterns %r matched NO committed artifact — the map is stale"
            % (gen, patterns),
        )

        # Same set of files must be produced (catches added/removed artifacts,
        # not just drifted bytes).
        self.assertEqual(
            set(committed), set(regen),
            "%s: regenerated artifact SET differs from committed.\n"
            "  only committed: %s\n  only regenerated: %s"
            % (gen,
               sorted(set(committed) - set(regen))[:20],
               sorted(set(regen) - set(committed))[:20]),
        )

        # Byte-identity, file by file.
        drifted = []
        for rel in sorted(committed):
            with open(committed[rel], "rb") as fh:
                want = fh.read()
            with open(regen[rel], "rb") as fh:
                got = fh.read()
            self._compare(gen, rel, want, got, drifted)
        self.assertFalse(
            drifted,
            "%s: %d committed artifact(s) are NOT reproducible from source "
            "(re-run `python3 %s.py`): %s"
            % (gen, len(drifted), gen, drifted[:20]),
        )

    def _compare(self, gen, rel, want, got, drifted):
        """Assert byte-identity of one artifact.

        Hook for the (currently unused) "structural identity modulo one pinned
        field" case: if some future artifact embeds a single volatile field,
        normalise it in BOTH ``want`` and ``got`` here — keyed on ``rel`` — with
        a documented comment, instead of skipping the artifact. As of now every
        artifact is a pure function of source, so a raw byte compare is honest.
        """
        if want != got:
            drifted.append(rel)

    def test_all_generators_covered(self):
        """Completeness: every gen_*.py on disk is in exactly one of GENERATORS
        / EXCLUDED, and neither map references a generator that does not exist.

        This is the guard that stops a future generator from silently escaping
        the umbrella — add it to GENERATORS (byte-checked) or, with a written
        reason, to EXCLUDED.
        """
        on_disk = set(_discover_generators())
        mapped = set(GENERATORS)
        excluded = set(EXCLUDED)

        overlap = mapped & excluded
        self.assertFalse(
            overlap, "generators in BOTH GENERATORS and EXCLUDED: %s"
            % sorted(overlap))

        missing = on_disk - mapped - excluded
        self.assertFalse(
            missing,
            "gen_*.py on disk not covered by GENERATORS or EXCLUDED "
            "(add each to one): %s" % sorted(missing))

        stale = (mapped | excluded) - on_disk
        self.assertFalse(
            stale,
            "GENERATORS/EXCLUDED name generators that do not exist on disk: %s"
            % sorted(stale))


def _make_test(gen, patterns):
    def test(self):
        self._check_generator(gen, patterns)
    test.__doc__ = ("regenerate %s.py into a temp copy -> byte-identical to the "
                    "committed artifact(s)" % gen)
    return test


for _gen, _patterns in GENERATORS.items():
    setattr(DeterminismTest, "test_" + _gen, _make_test(_gen, _patterns))


if __name__ == "__main__":
    unittest.main(verbosity=2)

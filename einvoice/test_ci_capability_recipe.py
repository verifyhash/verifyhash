#!/usr/bin/env python3
"""test_ci_capability_recipe.py — prove the QUICKSTART.md "fail fast" CI
capability recipe (T-VHINTRO.2) really gates on what `einvoice info --json`
reports, present AND absent case.

Fast, stdlib-only, offline, no pytest. The recipe command is EXTRACTED from
QUICKSTART.md itself (parsed out of the fenced code block under the
"Fail fast" subsection) — never hand-copied into this file — so the doc and
this test cannot drift apart: reword or break the documented one-liner and
this test fails.

Asserted (each maps to a task acceptance criterion):
  (a) QUICKSTART.md contains exactly one canonical fail-fast recipe of the
      documented shape `python3 -m einvoice info --json | python3 -c "..."`
      inside the "Fail fast" subsection, pure python3 stdlib (any jq variant
      in the doc is ignored here — jq is not installed on this box and is
      documented only as a labeled optional alternative).
  (b) The extracted recipe, run verbatim through the shell against the real
      build, exits 0 — the asserted capabilities (profile `xrechnung`,
      format `sarif`) are genuinely present per `info --json`.
  (c) The SAME recipe shape, with the required ids swapped for capabilities
      the build genuinely does not claim (profile `peppol`, format
      `bitbucket` — verified absent against live `info --json` output first,
      so this stays honest if capabilities ever grow), exits NON-ZERO, fast.
  (d) Read-only: nothing here (or in the recipe) validates an invoice or
      touches cli.py behavior — the recipe composes two existing commands.
"""

import json
import os
import re
import subprocess
import sys
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DOC = os.path.join(HERE, "QUICKSTART.md")

# The documented recipe must start exactly like this (the pure-stdlib form).
RECIPE_PREFIX = "python3 -m einvoice info --json | python3 -c "

# Present capabilities the doc's recipe requires / absent ones we swap in.
PRESENT_PROFILE, PRESENT_FORMAT = "xrechnung", "sarif"
ABSENT_PROFILE, ABSENT_FORMAT = "peppol", "bitbucket"


def extract_recipe():
    """Parse the canonical fail-fast one-liner out of QUICKSTART.md.

    Scope: the subsection whose heading contains "fail fast"
    (case-insensitive) up to the next heading; within it, the fenced code
    block lines that start with RECIPE_PREFIX. Exactly one must exist.
    """
    with open(DOC, encoding="utf-8") as fh:
        text = fh.read()
    m = re.search(r"^#+ .*fail fast.*?$(.*?)(?=^#+ )", text,
                  re.IGNORECASE | re.MULTILINE | re.DOTALL)
    if not m:
        raise AssertionError("QUICKSTART.md has no 'Fail fast' subsection")
    section = m.group(1)
    lines = []
    for block in re.findall(r"```[a-z]*\n(.*?)```", section, re.DOTALL):
        for raw in block.splitlines():
            line = raw.strip()
            if line.startswith(RECIPE_PREFIX):
                lines.append(line)
    if len(lines) != 1:
        raise AssertionError(
            "expected exactly one canonical python3-stdlib recipe line in the "
            "Fail fast subsection, found %d: %r" % (len(lines), lines))
    return lines[0]


def sh(cmd, timeout=60):
    """Run a doc command line through the shell, cwd = einvoice/ dir."""
    return subprocess.run(cmd, shell=True, cwd=HERE, capture_output=True,
                          text=True, timeout=timeout)


class Recipe(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.recipe = extract_recipe()
        proc = subprocess.run(
            [sys.executable, "-m", "einvoice", "info", "--json"],
            cwd=HERE, capture_output=True, text=True, timeout=60)
        assert proc.returncode == 0, proc.stderr
        cls.info = json.loads(proc.stdout)

    # -- (a) shape: pure python3 stdlib, requires the advertised ids ---------

    def test_recipe_is_pure_python_stdlib(self):
        self.assertTrue(self.recipe.startswith(RECIPE_PREFIX))
        self.assertNotIn("jq", self.recipe.split("python3 -c")[0],
                         "canonical recipe must not depend on jq")
        # It must import only stdlib modules (json/sys) in the -c payload.
        self.assertIn("import json,sys", self.recipe)

    def test_recipe_requires_the_expected_ids(self):
        self.assertIn("'%s'" % PRESENT_PROFILE, self.recipe)
        self.assertIn("'%s'" % PRESENT_FORMAT, self.recipe)

    # -- (b) present capability -> exit 0 ------------------------------------

    def test_present_capability_exits_zero(self):
        # Honesty guard: the ids the doc requires really are advertised.
        self.assertIn(PRESENT_PROFILE, self.info["profiles"])
        self.assertIn(PRESENT_FORMAT, self.info["formats"])
        proc = sh(self.recipe)
        self.assertEqual(
            proc.returncode, 0,
            "documented recipe must exit 0 for present capabilities\n"
            "cmd: %s\nstderr: %s" % (self.recipe, proc.stderr))

    # -- (c) absent capability -> fast non-zero ------------------------------

    def test_absent_capability_exits_nonzero_fast(self):
        # Honesty guard: neither artifact claims these ids. If a future build
        # ever implements them, pick new absent ids rather than weaken this.
        self.assertNotIn(ABSENT_PROFILE, self.info["profiles"])
        self.assertNotIn(ABSENT_FORMAT, self.info["formats"])

        absent = (self.recipe
                  .replace("'%s'" % PRESENT_PROFILE, "'%s'" % ABSENT_PROFILE)
                  .replace("'%s'" % PRESENT_FORMAT, "'%s'" % ABSENT_FORMAT))
        self.assertNotEqual(absent, self.recipe,
                            "id substitution failed — doc shape changed?")

        start = time.monotonic()
        proc = sh(absent)
        elapsed = time.monotonic() - start
        self.assertNotEqual(
            proc.returncode, 0,
            "recipe must exit non-zero when a required capability is absent\n"
            "cmd: %s" % absent)
        self.assertIn("AssertionError", proc.stderr,
                      "non-zero exit must come from the failed assert, not "
                      "some unrelated breakage:\n%s" % proc.stderr)
        self.assertLess(elapsed, 30,
                        "fail-fast recipe took %.1fs — not fast" % elapsed)


if __name__ == "__main__":
    unittest.main(verbosity=2)

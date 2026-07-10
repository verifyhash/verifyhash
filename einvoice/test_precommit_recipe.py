#!/usr/bin/env python3
"""test_precommit_recipe.py — prove the git pre-commit recipe in
`ci/pre-commit-einvoice.sh` really gates staged invoices through the REAL
`python3 -m einvoice.report` entrypoint and blocks a commit that introduces a
non-conformant invoice.

Fast, stdlib-only, saxonche-free, offline. Reuses the checked-in example
fixtures (examples/01-missing-fields/{broken,fixed}.xml) — no new corpus, no
network, no new deps. Plain python3 (no pytest); sys.exit(1) on the first
failed assertion, matching the repo's other test_*.py style.

Asserted (each maps to a task acceptance criterion):
  (a) ci/pre-commit-einvoice.sh exists and is executable.
  (b) hook run against the BAD fixture exits non-zero (commit would be blocked)
      and names the offending rule id.
  (c) hook run against the GOOD fixture exits zero.
  (d) hook run with NO file args (empty set, outside any staged XML) exits zero
      — inert on unrelated commits.
  (e) the script text references the real `einvoice.report` entrypoint (not the
      legacy `python3 -m einvoice` validate CLI).
  (f) ci/.pre-commit-config.yaml wires it as a local hook scoped to *.xml, and
      ci/README.md documents the opt-in hook driving einvoice.report.
"""

import os
import stat
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CI_DIR = os.path.join(HERE, "ci")
HOOK = os.path.join(CI_DIR, "pre-commit-einvoice.sh")
CONFIG = os.path.join(CI_DIR, ".pre-commit-config.yaml")
README = os.path.join(CI_DIR, "README.md")

BROKEN = os.path.join(HERE, "examples", "01-missing-fields", "broken.xml")
FIXED = os.path.join(HERE, "examples", "01-missing-fields", "fixed.xml")

FAILURES = []


def check(cond, msg):
    if cond:
        print("  ok: %s" % msg)
    else:
        print("  FAIL: %s" % msg)
        FAILURES.append(msg)


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def run_hook(args, cwd):
    """Run the hook with the given arg list from `cwd`. Ensure the einvoice
    package is importable regardless of cwd via PYTHONPATH."""
    env = dict(os.environ)
    env["PYTHONPATH"] = HERE + os.pathsep + env.get("PYTHONPATH", "")
    return subprocess.run(
        ["sh", HOOK, *args], cwd=cwd, env=env,
        capture_output=True, text=True, timeout=120)


def main():
    # (a) exists + executable
    check(os.path.isfile(HOOK), "hook script exists")
    mode = os.stat(HOOK).st_mode
    check(bool(mode & stat.S_IXUSR), "hook script is executable")

    # (e) references the real entrypoint, not the legacy CLI
    text = read(HOOK)
    check("einvoice.report" in text, "hook references einvoice.report entrypoint")

    # sanity: fixtures present
    check(os.path.isfile(BROKEN), "bad fixture present: %s" % BROKEN)
    check(os.path.isfile(FIXED), "good fixture present: %s" % FIXED)

    # (b) BAD fixture -> non-zero (commit blocked), rule id named
    bad = run_hook([BROKEN], cwd=HERE)
    check(bad.returncode != 0,
          "bad invoice blocks the commit (exit %d != 0)" % bad.returncode)
    check("BR-DE" in bad.stdout,
          "bad invoice run names an offending rule id (BR-DE-*)")

    # (c) GOOD fixture -> zero
    good = run_hook([FIXED], cwd=HERE)
    check(good.returncode == 0,
          "good invoice passes (exit %d == 0)\n%s%s"
          % (good.returncode, good.stdout, good.stderr))

    # (d) NO args, run from a non-git temp dir -> inert, exit zero
    with tempfile.TemporaryDirectory() as tmp:
        inert = run_hook([], cwd=tmp)
    check(inert.returncode == 0,
          "no invoice files -> hook inert (exit %d == 0)" % inert.returncode)

    # (f) config + README wiring
    cfg = read(CONFIG)
    check("repo: local" in cfg, ".pre-commit-config.yaml uses a local hook")
    check("pre-commit-einvoice.sh" in cfg,
          ".pre-commit-config.yaml wires the hook script")
    check("\\.xml$" in cfg, ".pre-commit-config.yaml scopes files to *.xml")

    doc = read(README)
    check("pre-commit" in doc, "README documents the pre-commit hook")
    check("einvoice.report" in doc,
          "README states the hook drives the real einvoice.report entrypoint")
    check("opt in" in doc.lower() or "opt-in" in doc.lower(),
          "README states the hook is opt-in / installs nothing automatically")

    if FAILURES:
        print("\nFAIL: %d check(s) failed" % len(FAILURES))
        sys.exit(1)
    print("\nPASS: pre-commit recipe gates staged invoices through "
          "python3 -m einvoice.report")


if __name__ == "__main__":
    main()

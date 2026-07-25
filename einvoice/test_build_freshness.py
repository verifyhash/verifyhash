#!/usr/bin/env python3
"""test_build_freshness.py — trap detector for a STALE setuptools build tree.

THE TRAP
--------
`setuptools` does not regenerate `build/lib/` from scratch. It copies the
package sources into that directory and leaves whatever is already there in
place, so a PEP 517 build run over an old `build/` can silently package
modules from a previous build. The resulting wheel is named correctly, imports
cleanly and reports the right `--version`; it just contains different code than
the checkout it was built from.

Measured at commit 7c0a0d8: `einvoice/build/lib/einvoice/` held three modules
(`validate.py`, `report.py`, `coverage.py`) that were byte-for-byte different
from `einvoice/einvoice/`. A wheel built in-tree from that state rejected a
valid raw CII invoice with the pre-fix S-ROOT fatal (exit 1) while a wheel
built from `git archive HEAD` accepted it (exit 0) — same commit, same declared
version 0.2.7, two different validators. PyPI versions are immutable, so
uploading that wheel would have been unrecoverable.

WHAT THIS TEST DOES
-------------------
If `einvoice/build/lib/einvoice/` does not exist, there is nothing to detect and
the test PASSES trivially (it says so). It must never require a build to exist —
a clean checkout is the healthy state, and `build/` is untracked, gitignored,
derived junk.

If it does exist, every `.py` file under it must be byte-identical to its
counterpart under `einvoice/einvoice/`, in BOTH directions: a module present on
only one side is a failure too. Every problem message names the offending file
and tells the reader to `rm -rf build/`.

The file also carries a NEGATIVE SELF-TEST that builds synthetic directory
pairs under tempfile.mkdtemp() and asserts the checker actually reports named
problems for a byte-differing module and for an orphan file. Without it this
test would pass vacuously forever on a clean tree.

Standard library only. Offline: no pip, no build, no network, no subprocess.
Runs in well under a second.
"""

import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD_LIB = os.path.join(HERE, "build", "lib", "einvoice")
SOURCE_PKG = os.path.join(HERE, "einvoice")

REMEDY = "remove the stale tree: rm -rf build/ (from einvoice/), then rebuild"


def _py_files(directory):
    """Relative paths of every .py file under `directory` (recursive, sorted).

    Only .py files are compared. Non-Python package data (README.md, RULES.md,
    JSON catalogs) is copied into build/lib by different setuptools machinery
    with its own inclusion rules, so a mismatch there is not evidence of a
    stale tree; a mismatched *module* always is.
    """
    found = []
    for root, dirnames, filenames in os.walk(directory):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for name in filenames:
            if name.endswith(".py"):
                full = os.path.join(root, name)
                found.append(os.path.relpath(full, directory))
    return sorted(found)


def _same_bytes(path_a, path_b):
    try:
        with open(path_a, "rb") as fa, open(path_b, "rb") as fb:
            return fa.read() == fb.read()
    except OSError as exc:                      # unreadable == not provably same
        return "unreadable (%s)" % exc


def check_build_freshness(build_lib_dir, source_pkg_dir):
    """Return a list of human-readable problem strings (empty list == clean).

    `build_lib_dir` absent  -> [] (nothing was ever built; nothing to go stale).
    `source_pkg_dir` absent -> a problem, because then the comparison is
    meaningless and something is badly wrong with the checkout.
    """
    problems = []

    if not os.path.isdir(build_lib_dir):
        return problems

    if not os.path.isdir(source_pkg_dir):
        problems.append(
            "source package directory %s does not exist, so the build tree %s "
            "cannot be checked against anything — %s"
            % (source_pkg_dir, build_lib_dir, REMEDY))
        return problems

    built = _py_files(build_lib_dir)
    source = _py_files(source_pkg_dir)

    for rel in built:
        if rel not in source:
            problems.append(
                "ORPHAN in build tree: %s exists under %s but NOT under %s — it "
                "is a module from an older layout and a wheel built now would "
                "ship it; %s"
                % (rel, build_lib_dir, source_pkg_dir, REMEDY))

    for rel in source:
        if rel not in built:
            problems.append(
                "MISSING from build tree: %s exists under %s but NOT under %s — "
                "the build tree predates this module, so a wheel built now "
                "could ship without it; %s"
                % (rel, source_pkg_dir, build_lib_dir, REMEDY))

    for rel in built:
        if rel not in source:
            continue
        verdict = _same_bytes(os.path.join(build_lib_dir, rel),
                              os.path.join(source_pkg_dir, rel))
        if verdict is not True:
            detail = "" if verdict is False else " [%s]" % verdict
            problems.append(
                "STALE: %s in the build tree differs byte-wise from the source "
                "%s%s — a wheel built now would package the OLD %s; %s"
                % (rel, os.path.join(source_pkg_dir, rel), detail, rel, REMEDY))

    return problems


# --------------------------------------------------------------------------
# NEGATIVE SELF-TEST — proves the checker can actually fail.
#
# A freshness guard that only ever runs against a clean tree is indistinguish-
# able from `pass`. These cases build synthetic directory pairs in a temp dir
# and assert the checker reports a problem that NAMES the offending file.
# --------------------------------------------------------------------------

def _write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)


def _make_pair(tmp):
    """An identical (build_lib, source_pkg) pair with two modules + a subpkg."""
    build_lib = os.path.join(tmp, "build", "lib", "pkg")
    source = os.path.join(tmp, "src", "pkg")
    files = {
        "__init__.py": b'__version__ = "0.2.7"\n',
        "validate.py": b"def validate(doc):\n    return []\n",
        os.path.join("sub", "helper.py"): b"HELPER = 1\n",
        "notes.md": b"not a module; must be ignored\n",
    }
    for rel, data in files.items():
        _write(os.path.join(build_lib, rel), data)
        _write(os.path.join(source, rel), data)
    return build_lib, source


def run_negative_self_test():
    """Return (failures, checks_run)."""
    failures = []
    checks = 0

    def expect(cond, name, detail=""):
        print("  [%s] %s%s" % ("ok" if cond else "FAIL", name,
                               ("" if cond else " — " + detail)))
        if not cond:
            failures.append(name)

    # --- case 0: an identical pair must be reported CLEAN -----------------
    tmp = tempfile.mkdtemp(prefix="vh-freshness-clean-")
    try:
        build_lib, source = _make_pair(tmp)
        problems = check_build_freshness(build_lib, source)
        checks += 1
        expect(problems == [], "identical pair -> zero problems",
               "unexpected problems: %r" % (problems,))

        # a non-.py difference must NOT be reported (scope is modules)
        _write(os.path.join(build_lib, "notes.md"), b"changed prose\n")
        problems = check_build_freshness(build_lib, source)
        checks += 1
        expect(problems == [], "non-.py drift is out of scope -> zero problems",
               "unexpected problems: %r" % (problems,))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # --- case 1: ONE mutated byte in a module must be caught, BY NAME -----
    tmp = tempfile.mkdtemp(prefix="vh-freshness-mutate-")
    try:
        build_lib, source = _make_pair(tmp)
        target = os.path.join(build_lib, "validate.py")
        with open(target, "rb") as fh:
            original = fh.read()
        with open(target, "wb") as fh:                 # flip exactly one byte
            fh.write(original[:4] + b"X" + original[5:])
        with open(target, "rb") as fh:
            mutated = fh.read()
        expect(len(mutated) == len(original) and mutated != original,
               "mutation changed exactly one byte", "mutation did not take")
        checks += 1

        problems = check_build_freshness(build_lib, source)
        checks += 1
        expect(len(problems) >= 1, "byte-differing module -> a problem",
               "checker reported nothing for a mutated validate.py")
        checks += 1
        expect(any("validate.py" in p for p in problems),
               "problem NAMES the differing file",
               "problems did not mention validate.py: %r" % (problems,))
        checks += 1
        expect(all("rm -rf build/" in p for p in problems),
               "problem tells the reader to rm -rf build/",
               "remedy missing from: %r" % (problems,))

        # a mutation inside a SUBPACKAGE must be caught too
        _write(os.path.join(build_lib, "sub", "helper.py"), b"HELPER = 2\n")
        problems = check_build_freshness(build_lib, source)
        checks += 1
        expect(any("helper.py" in p for p in problems),
               "subpackage drift is caught and named",
               "problems: %r" % (problems,))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # --- case 2: an ORPHAN present on only one side must be caught --------
    tmp = tempfile.mkdtemp(prefix="vh-freshness-orphan-")
    try:
        build_lib, source = _make_pair(tmp)
        _write(os.path.join(build_lib, "retired_module.py"), b"OLD = True\n")
        problems = check_build_freshness(build_lib, source)
        checks += 1
        expect(any("retired_module.py" in p for p in problems),
               "build-only orphan -> a problem naming it",
               "problems: %r" % (problems,))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    tmp = tempfile.mkdtemp(prefix="vh-freshness-missing-")
    try:
        build_lib, source = _make_pair(tmp)
        _write(os.path.join(source, "brand_new.py"), b"NEW = True\n")
        problems = check_build_freshness(build_lib, source)
        checks += 1
        expect(any("brand_new.py" in p for p in problems),
               "source-only module -> a problem naming it",
               "problems: %r" % (problems,))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # --- case 3: absent build dir is a trivial PASS, never an error -------
    tmp = tempfile.mkdtemp(prefix="vh-freshness-absent-")
    try:
        _, source = _make_pair(tmp)
        problems = check_build_freshness(
            os.path.join(tmp, "build", "lib", "does-not-exist"), source)
        checks += 1
        expect(problems == [], "absent build tree -> zero problems",
               "problems: %r" % (problems,))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    return failures, checks


def main():
    print("test_build_freshness.py — stale setuptools build/lib detector")

    print("\nNEGATIVE SELF-TEST (synthetic trees under tempfile.mkdtemp)")
    self_failures, checks = run_negative_self_test()
    print("  %d self-checks run" % checks)

    print("\nREAL TREE: %s" % BUILD_LIB)
    real_problems = check_build_freshness(BUILD_LIB, SOURCE_PKG)
    if not os.path.isdir(BUILD_LIB):
        print("  [ok] no build/lib/einvoice/ present — this is a TRAP DETECTOR")
        print("       WITH NOTHING TO DETECT, which is the healthy state. A")
        print("       clean checkout has no build tree; a PEP 517 build")
        print("       creates one, and it goes stale the moment a source file")
        print("       changes. Nothing to compare, so this passes trivially.")
    elif not real_problems:
        n = len(_py_files(BUILD_LIB))
        print("  [ok] build/lib/einvoice/ exists and all %d module(s) are "
              "byte-identical to einvoice/einvoice/" % n)
    else:
        for problem in real_problems:
            print("  [FAIL] %s" % problem)

    total = len(self_failures) + len(real_problems)
    print("")
    if total:
        print("FAIL — %d problem(s): %d self-test, %d in the real tree"
              % (total, len(self_failures), len(real_problems)))
        if real_problems:
            print("Fix: cd %s && rm -rf build/ dist/ *.egg-info" % HERE)
        return 1
    print("PASS — build-freshness trap is guarded")
    return 0


if __name__ == "__main__":
    sys.exit(main())

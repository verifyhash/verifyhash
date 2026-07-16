#!/usr/bin/env python3
"""test_install_command_drift.py — a doc-drift guard that makes one specific,
brand-fatal honesty bug impossible to silently reintroduce.

The bug it kills: shipped docs/manifests/recipes once told readers to run
`pip install einvoice`. That command does NOT install this project — `einvoice`
is an UNRELATED third-party package already on PyPI. The validator in this repo
is NOT yet on PyPI; its future name is `verifyhash-einvoice` (staged by
EPIC-PYPI, owner uploads later). Until that first publish, the only working
install is from a checkout / vendored copy, e.g.:

    python3 -m pip install /path/to/einvoice          # from a checkout
    python3 -m pip install ./third_party/einvoice     # vendored copy

So every install reference must be one of:
  * `pip install verifyhash-einvoice` (the real, pending package name), or
  * a path install (`pip install /path/...`, `pip install ./...`, `pip install .`).

This test walks every shipped Markdown / YAML file under the repo and FAILS if
any line names the bare wrong package — `pip install einvoice` where `einvoice`
is a standalone token (not `verifyhash-einvoice`, not a filesystem path). It
does not care about wording; it only refuses the one command that fetches
someone else's package.

Fast, offline, zero third-party deps. Plain python3 (no pytest); exits 1 on the
first offending line, matching the other test_*.py in this tree.
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))          # .../verifyhash/einvoice
REPO_ROOT = os.path.dirname(HERE)                          # .../verifyhash

# Extensions that carry shipped install instructions (docs / manifests / CI
# recipes). Deliberately NOT *.py: source/test files are not user-facing
# install recipes, and scanning them would trip on this file's own literal
# regex below.
SCAN_EXT = (".md", ".yaml", ".yml")

# Directories we never treat as "shipped docs": VCS internals and vendored
# node deps (the einvoice validator is pure-Python and ships none of that).
SKIP_DIRS = {".git", "node_modules"}

# The name of this guard itself — never scan it, so its documentation of the
# wrong pattern can never make the guard fail against itself.
SELF = os.path.basename(__file__)

# A violation: `pip install einvoice` where `einvoice` is a bare package token
# — i.e. NOT immediately followed by a word char, hyphen, dot or slash. This
# matches `pip install einvoice`, `python3 -m pip install einvoice`, and
# `pip install einvoice);` but NOT `verifyhash-einvoice`, `/path/to/einvoice`,
# `./third_party/einvoice`, or a plain `pip install .`.
WRONG = re.compile(r"pip\s+install\s+einvoice(?![\w./-])")


def is_changelog(name):
    return "changelog" in name.lower()


def iter_shipped_files():
    for dirpath, dirnames, filenames in os.walk(REPO_ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if name == SELF or is_changelog(name):
                continue
            if name.endswith(SCAN_EXT):
                yield os.path.join(dirpath, name)


def scan_file(path):
    """Return a list of (lineno, line) that name the wrong bare package."""
    hits = []
    try:
        with open(path, encoding="utf-8") as fh:
            for i, line in enumerate(fh, 1):
                if "pip install" in line and WRONG.search(line):
                    hits.append((i, line.rstrip("\n")))
    except (UnicodeDecodeError, OSError):
        # A non-text or unreadable file carries no install prose; skip it.
        pass
    return hits


def self_test():
    """The detector's own contract, proven inline so a broken detector can't
    pass this guard by simply matching nothing."""
    must_flag = [
        "python3 -m pip install einvoice",
        "pip install einvoice",
        "run: pip install einvoice",
        "package importable (python3 -m pip install einvoice); installs nothing",
        "pip install einvoice==1.0",
    ]
    must_pass = [
        "python3 -m pip install verifyhash-einvoice",
        "python3 -m pip install /path/to/einvoice",
        "python3 -m pip install ./third_party/einvoice",
        "python3 -m pip install .",
        "no `pip install` is needed: the validator is stdlib-only",
    ]
    ok = True
    for s in must_flag:
        if not WRONG.search(s):
            print("  SELFTEST FAIL: detector missed a wrong line: %r" % s)
            ok = False
    for s in must_pass:
        if WRONG.search(s):
            print("  SELFTEST FAIL: detector flagged a correct line: %r" % s)
            ok = False
    return ok


def main():
    if not self_test():
        print("\nFAIL: drift detector self-test failed (bug in the guard itself)")
        sys.exit(1)
    print("  ok: detector self-test (flags the wrong package, allows the right forms)")

    scanned = 0
    offenders = []
    for path in iter_shipped_files():
        scanned += 1
        for lineno, line in scan_file(path):
            rel = os.path.relpath(path, REPO_ROOT)
            offenders.append((rel, lineno, line.strip()))

    print("  ok: scanned %d shipped .md/.yaml/.yml file(s) under %s"
          % (scanned, REPO_ROOT))

    if offenders:
        print("\nFAIL: %d install reference(s) name the WRONG package "
              "(`pip install einvoice` fetches an unrelated third-party "
              "package; use `pip install verifyhash-einvoice` or a checkout/"
              "vendored path):" % len(offenders))
        for rel, lineno, line in offenders:
            print("  %s:%d: %s" % (rel, lineno, line))
        sys.exit(1)

    print("\nPASS: no shipped doc/manifest names the wrong `pip install` package")


if __name__ == "__main__":
    main()

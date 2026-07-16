#!/usr/bin/env python3
"""test_pre_commit_hooks.py — prove the PROVIDER-side pre-commit hook manifest
(`.pre-commit-hooks.yaml` at the verifyhash REPO ROOT) is the real thing a
remote `repo:` reference resolves, and that the hook it declares actually gates
invoices end-to-end.

Background: pre-commit (https://pre-commit.com) resolves a hook PROVIDER by
cloning the referenced repo and reading `.pre-commit-hooks.yaml` from the clone
ROOT. This test checks that file, not a consumer `.pre-commit-config.yaml`
(that vendor-copy path is covered by test_precommit_recipe.py).

Fast, offline, saxonche-free, no new runtime dep. Uses PyYAML if importable and
otherwise a tiny stdlib fallback parser (the manifest is a flat one-hook list),
so the einvoice package's zero-dependency contract is never touched. Plain
python3 (no pytest); sys.exit(1) on the first failed assertion, matching the
other test_*.py in this tree.

Asserted (each maps to a task acceptance criterion):
  1. the manifest exists at the repo root and is valid YAML declaring EXACTLY
     one hook with `id: einvoice`.
  2. the hook `entry` resolves to the committed wrapper that drives the real
     `python3 -m einvoice.report` entrypoint (no re-implemented validation).
  3. the manifest declares `files: \\.xml$` and `pass_filenames: true`.
  4. `language: script` (the honest choice for a subdir package — see the
     manifest header and einvoice/README.md).
  5. running the DECLARED entry the way pre-commit would (entry resolved from
     the repo root, matched filename passed as an arg) exits 0 on a bundled
     VALID fixture and non-zero on a bundled INVALID fixture.
  6. einvoice/README.md carries a 'Use as a pre-commit hook' section with the
     copy-paste remote `repos:` block and the install prerequisite.
"""

import os
import re
import stat
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))          # .../verifyhash/einvoice
REPO_ROOT = os.path.dirname(HERE)                          # .../verifyhash
MANIFEST = os.path.join(REPO_ROOT, ".pre-commit-hooks.yaml")
README = os.path.join(HERE, "README.md")

# Bundled fixtures reused verbatim (no new corpus): a conformant invoice and a
# non-conformant one that trips fatal BR-DE-* rules.
VALID = os.path.join(HERE, "examples", "01-missing-fields", "fixed.xml")
INVALID = os.path.join(HERE, "examples", "01-missing-fields", "broken.xml")

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


def load_manifest(text):
    """Parse the manifest into a list-of-dicts. Prefer PyYAML; fall back to a
    minimal parser for the flat single-hook shape this manifest uses so the
    test does not depend on a third-party lib being present."""
    try:
        import yaml  # noqa: WPS433 (optional, test-only)
        data = yaml.safe_load(text)
        return data, "pyyaml"
    except ImportError:
        pass

    # Minimal fallback: a top-level YAML list of `key: value` scalars, with a
    # `>-` folded block for `description`. Sufficient for this manifest only.
    hooks = []
    cur = None
    in_folded = None
    for raw in text.splitlines():
        line = raw.rstrip("\n")
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if in_folded is not None:
            # folded block continues while indented deeper than its key
            if line[:1] in (" ", "\t") and (len(line) - len(line.lstrip())) > in_folded[1]:
                cur[in_folded[0]] = (cur.get(in_folded[0], "") + " " + stripped).strip()
                continue
            in_folded = None
        if stripped.startswith("- "):
            cur = {}
            hooks.append(cur)
            stripped = stripped[2:].strip()
        if cur is None:
            continue
        m = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", stripped)
        if not m:
            continue
        key, val = m.group(1), m.group(2)
        if val in (">-", ">", "|", "|-"):
            indent = len(line) - len(line.lstrip())
            in_folded = (key, indent)
            cur[key] = ""
            continue
        # strip surrounding quotes and normalize booleans
        val = val.strip()
        if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
            val = val[1:-1]
        if val.lower() == "true":
            val = True
        elif val.lower() == "false":
            val = False
        cur[key] = val
    return hooks, "fallback"


def run_entry(entry, fixture):
    """Run the DECLARED entry the way pre-commit does: entry path resolved from
    the repo (clone) root, cwd at that root, matched filename as an argument.
    PYTHONPATH points at the einvoice package dir so the wrapper's
    `python3 -m einvoice.report` shell-out imports cleanly regardless of a real
    `pip install einvoice` in this sandbox."""
    env = dict(os.environ)
    env["PYTHONPATH"] = HERE + os.pathsep + env.get("PYTHONPATH", "")
    return subprocess.run(
        ["sh", entry, fixture], cwd=REPO_ROOT, env=env,
        capture_output=True, text=True, timeout=120)


def main():
    # (1) manifest exists at repo root, valid YAML, exactly one hook: einvoice
    check(os.path.isfile(MANIFEST),
          ".pre-commit-hooks.yaml exists at repo root: %s" % MANIFEST)
    text = read(MANIFEST)
    hooks, parser = load_manifest(text)
    print("  (parsed with: %s)" % parser)
    check(isinstance(hooks, list), "manifest is a YAML list of hooks")
    check(isinstance(hooks, list) and len(hooks) == 1,
          "manifest declares EXACTLY one hook (got %d)"
          % (len(hooks) if isinstance(hooks, list) else -1))
    if not (isinstance(hooks, list) and hooks and isinstance(hooks[0], dict)):
        print("\nFAIL: manifest did not parse into a hook mapping")
        sys.exit(1)
    hook = hooks[0]
    check(hook.get("id") == "einvoice",
          "hook id is 'einvoice' (got %r)" % hook.get("id"))
    check(bool(str(hook.get("name", "")).strip()),
          "hook declares a human name")
    check(bool(str(hook.get("description", "")).strip()),
          "hook declares a description")

    # (2) entry -> committed wrapper that drives the real einvoice.report
    entry = str(hook.get("entry", ""))
    check(entry == "einvoice/ci/pre-commit-einvoice.sh",
          "entry is the repo-root-relative wrapper (got %r)" % entry)
    entry_abs = os.path.join(REPO_ROOT, entry)
    check(os.path.isfile(entry_abs), "entry script exists on disk: %s" % entry_abs)
    check(os.path.isfile(entry_abs) and bool(os.stat(entry_abs).st_mode & stat.S_IXUSR),
          "entry script is executable")
    if os.path.isfile(entry_abs):
        wrapper = read(entry_abs)
        check("einvoice.report" in wrapper,
              "wrapper drives the real einvoice.report entrypoint")

    # (3) files + pass_filenames
    check(hook.get("files") == r"\.xml$",
          "files pattern is \\.xml$ (got %r)" % hook.get("files"))
    check(hook.get("pass_filenames") is True,
          "pass_filenames is true (got %r)" % hook.get("pass_filenames"))

    # (4) honest language for a subdir package
    check(hook.get("language") == "script",
          "language is 'script' (honest for a subdir package; got %r)"
          % hook.get("language"))

    # (5) run the declared entry end-to-end: 0 on valid, non-zero on invalid
    check(os.path.isfile(VALID), "valid fixture present: %s" % VALID)
    check(os.path.isfile(INVALID), "invalid fixture present: %s" % INVALID)

    good = run_entry(entry, VALID)
    check(good.returncode == 0,
          "declared entry exits 0 on the VALID fixture (got %d)\n%s%s"
          % (good.returncode, good.stdout, good.stderr))

    bad = run_entry(entry, INVALID)
    check(bad.returncode != 0,
          "declared entry exits non-zero on the INVALID fixture (got %d)"
          % bad.returncode)
    check("BR-DE" in bad.stdout,
          "invalid run names an offending rule id (BR-DE-*)")

    # (6) README section: remote repos: block + install prerequisite
    doc = read(README)
    check("Use as a pre-commit hook" in doc,
          "einvoice/README.md has a 'Use as a pre-commit hook' section")
    check("repo: https://github.com/verifyhash/verifyhash" in doc,
          "README section has the remote repos: block")
    check("- id: einvoice" in doc,
          "README repos: block references the einvoice hook id")
    check("pip install einvoice" in doc,
          "README documents the install prerequisite (pip install einvoice)")
    check("language: script" in doc,
          "README explains the honest language: script choice")

    if FAILURES:
        print("\nFAIL: %d check(s) failed" % len(FAILURES))
        sys.exit(1)
    print("\nPASS: provider .pre-commit-hooks.yaml declares the einvoice hook "
          "and it gates fixtures through python3 -m einvoice.report")


if __name__ == "__main__":
    main()

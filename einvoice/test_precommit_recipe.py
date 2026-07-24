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
  (g) every `rev:` the REMOTE recipe documents (repo-root .pre-commit-hooks.yaml)
      is a ref that can actually resolve — this repo has no git tags, so a
      `v*`-shaped rev would hand adopters an unresolvable pin. The full
      cross-file sweep lives in test_doc_refs_resolvable.py.
  (h) INSTALL-HINT PARITY: the unimportable-validator hint printed by BOTH CI
      scripts (ci/pre-commit-einvoice.sh, ci/validate-invoices.sh) and the
      remote manifest that INVOKES the first of them (.pre-commit-hooks.yaml)
      must offer the SAME primary install command, and it must be the real
      published distribution `verifyhash-einvoice` — not a `/path/to/einvoice`
      the stuck adopter does not have. Regression pinned: until T-VHTRUTH.3 the
      manifest said `pip install verifyhash-einvoice` while the script it ran
      said `pip install /path/to/einvoice`, so the recipe and its own script
      disagreed at the exact moment an adopter was blocked. Also pinned here:
      the local-checkout route is still OFFERED (air-gapped CI needs it) but
      strictly AFTER the PyPI line, and neither script ever EXECUTES an install
      — every `pip install` occurrence stays inside an `echo`.
"""

import os
import re
import stat
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CI_DIR = os.path.join(HERE, "ci")
ROOT_MANIFEST = os.path.join(os.path.dirname(HERE), ".pre-commit-hooks.yaml")
#: `main` or a full 40-hex commit SHA — the only refs that resolve today.
RESOLVABLE_REV = re.compile(r"\A(?:main|[0-9a-f]{40})\Z")
HOOK = os.path.join(CI_DIR, "pre-commit-einvoice.sh")
GATE = os.path.join(CI_DIR, "validate-invoices.sh")
CONFIG = os.path.join(CI_DIR, ".pre-commit-config.yaml")
README = os.path.join(CI_DIR, "README.md")

#: The ONE PyPI distribution name this project publishes the validator under,
#: pinned as a literal so the parity assertion in (h) can never go vacuous by
#: comparing two files that drifted together onto some other command.
DIST = "verifyhash-einvoice"
PRIMARY_INSTALL = "python3 -m pip install " + DIST
#: First `python3 -m pip install <target>` a reader meets in a file. The target
#: stops at whitespace or the punctuation these files wrap commands in.
INSTALL_CMD = re.compile(r"python3 -m pip install ([^\s\"'`),;]+)")
#: The local-checkout alternative that must stay offered, but only AFTER PyPI.
CHECKOUT_PATH = "/path/to/einvoice"

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


def primary_install(path):
    """The FIRST `python3 -m pip install <target>` command in `path`, i.e. the
    remedy a stuck reader tries first. None if the file names none."""
    m = INSTALL_CMD.search(read(path))
    return m.group(0) if m else None


def install_hint_parity():
    """(h) The scripts' hint and the manifest that invokes them must name the
    same primary install command, and the checkout route must stay available
    below it without ever being executed."""
    sources = (
        ("ci/pre-commit-einvoice.sh", HOOK),
        ("ci/validate-invoices.sh", GATE),
        (".pre-commit-hooks.yaml", ROOT_MANIFEST),
    )
    primaries = {}
    for label, path in sources:
        cmd = primary_install(path)
        primaries[label] = cmd
        check(cmd == PRIMARY_INSTALL,
              "%s offers %r as its FIRST install command (got %r)"
              % (label, PRIMARY_INSTALL, cmd))
    check(len(set(primaries.values())) == 1,
          "the two CI scripts and .pre-commit-hooks.yaml agree on ONE primary "
          "install command (no drift): %r" % (primaries,))

    for label, path in sources[:2]:
        body = read(path)
        pypi_at = body.find(DIST)
        checkout_at = body.find(CHECKOUT_PATH)
        check(pypi_at != -1 and (checkout_at == -1 or pypi_at < checkout_at),
              "%s names %s BEFORE any %s (PyPI is the first remedy offered)"
              % (label, DIST, CHECKOUT_PATH))
        check(checkout_at != -1,
              "%s still offers the checkout/vendored route (%s) as an "
              "alternative — the honest air-gapped answer" % (label, CHECKOUT_PATH))
        executed = [l.strip() for l in body.splitlines()
                    if "pip install" in l and "echo" not in l]
        check(not executed,
              "%s never EXECUTES an install (every `pip install` sits inside an "
              "echo); offending line(s): %r" % (label, executed))


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

    # (g) the remote recipe's documented rev must be resolvable (no tags exist)
    revs = re.findall(r"\brev:\s*(\S+)", read(ROOT_MANIFEST))
    check(bool(revs) and all(RESOLVABLE_REV.match(r) for r in revs),
          "root .pre-commit-hooks.yaml documents resolvable rev(s) "
          "(main / 40-hex sha), not a v*-shaped tag: %r" % (revs,))

    # (h) install-hint <-> manifest parity (see the module docstring)
    check(os.path.isfile(GATE), "CI gate script exists: %s" % GATE)
    install_hint_parity()

    if FAILURES:
        print("\nFAIL: %d check(s) failed" % len(FAILURES))
        sys.exit(1)
    print("\nPASS: pre-commit recipe gates staged invoices through "
          "python3 -m einvoice.report")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""test_release_preflight.py — STATIC + offline self-test for
tools/release-preflight.sh.

The script under test is SUPERVISOR-ONLY: it creates a venv and runs
`pip install` of a locally built wheel, immediately upstream of an IMMUTABLE
PyPI upload. The loop must never execute it — same standing as
tools/einvoice-deploy.sh (see test_deploy_script.py, whose structure this file
follows). So everything below is read off the script's SOURCE TEXT, plus a
`bash -n` PARSE (which does not execute a single command), plus one reuse of
test_wheel_self_report.build_install_image() to prove the artifacts the preflight
asserts on are artifacts we actually ship.

WHAT IS ASSERTED, each mapped to a real failure mode:

  1. PRESENT AND RUNNABLE BY HAND: the file exists and carries the executable
     bit. A preflight the supervisor has to remember to prefix with `bash` is a
     preflight that gets skipped. (`bash -n` also proves it parses — a syntax
     error would only surface at publish time, i.e. the worst moment.)
  2. SAFE SHELL: `set -euo pipefail`. Without `-e` a failing check would print
     FAIL and then carry on to print the ALL-PASSED banner.
  3. NO PUBLISH-ADJACENT POWER: with comments and here-doc bodies stripped, the
     script contains no `sudo`, no `twine`, no `git push`, no `npm publish`, and
     no networked install (`--index-url` / `--extra-index-url` / `pip download`
     / curl / wget). The stripping matters: the header comment legitimately
     NAMES `twine upload` when explaining where in REPUBLISH-PYPI.md this step
     sits, and prose is not power.
  4. OFFLINE INSTALL: the one install is `pip install ... --no-index`, so the
     wheel under test is the local file named on the command line and nothing
     is resolved from an index.
  5. ALL SEVEN CHECKS PRESENT: each of the seven `<n> <name>` check ids the
     contract names appears in the script body. A silently dropped check is the
     failure mode that returns us to auditing wheels after the upload.
  6. READS NO REPO FIXTURE: no `fixtures/` path and no `corpus/` path — the
     preflight must work from a temp dir with the repo off PYTHONPATH, so its
     invoices are written inline (here-docs) or come from the wheel.
  7. ARTIFACTS REALLY SHIPPED: the two files check 2 asserts on
     (`remediation_catalog.json`, `attestation.json`) exist in the
     WHEEL-DECLARED install image, rebuilt here via
     test_wheel_self_report.build_install_image() (REUSED, not reimplemented).
     Without this the preflight could confidently assert on something the wheel
     does not contain, and the assertion would be the bug.

Standard library only. Offline: no pip, no `python -m build`, no network, no
execution of the script under test. Runs in well under a second.
"""

import os
import re
import stat
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

SCRIPT = os.path.join(HERE, "tools", "release-preflight.sh")
REL = os.path.join("tools", "release-preflight.sh")

#: The seven checks the contract names, as the `<n> <name>` pairs the script
#: prints (`PASS 3 formats-and-explain` / `FAIL 3 formats-and-explain`).
EXPECTED_CHECKS = (
    (1, "version-and-rule-count"),
    (2, "shipped-artifacts"),
    (3, "formats-and-explain"),
    (4, "remediation-fields"),
    (5, "report-module-help"),
    (6, "help-pointer-is-url"),
    (7, "cii-valid-and-broken-twin"),
)

#: Powers a preflight must not have. Each is matched against the STRIPPED text
#: (comments and here-doc bodies removed) as a regex.
FORBIDDEN = (
    (r"\bsudo\b", "sudo — the preflight runs entirely as the invoking user"),
    (r"\btwine\b", "twine — uploading is a separate, later, human step"),
    (r"\bgit\s+push\b", "git push — nothing here is a remote git operation"),
    (r"\bnpm\s+publish\b", "npm publish — wrong ecosystem and wrong authority"),
    (r"--(extra-)?index-url", "a networked index (the install must be --no-index)"),
    (r"\bpip\s+(download|search)\b", "a network pip subcommand"),
    (r"\bcurl\b", "curl — the script must not fetch anything"),
    (r"\bwget\b", "wget — the script must not fetch anything"),
)

FAILURES = []


def check(cond, name, detail=""):
    status = "ok" if cond else "FAIL"
    print("  [%s] %s%s" % (status, name, (" — " + detail) if (detail and not cond) else ""))
    if not cond:
        FAILURES.append(name)


def strip_comments_and_heredocs(text):
    """Return the script's EXECUTABLE text: full-line comments, spaced inline
    comments and here-doc BODIES removed.

    Here-doc bodies are dropped because they carry payload, not power: the usage
    banner, the runtime banner, the inline CII invoice and the small embedded
    Python block. A word appearing only in a here-doc or a comment cannot make
    the script do anything, and the header comment has to be free to explain
    where `twine upload` sits in the runbook.
    """
    out = []
    terminator = None
    # `<<'EOF'`, `<<"EOF"`, `<<EOF`, `<<-EOF` — this script only uses the
    # quoted form, but accept the others so a future edit cannot smuggle a body
    # past the stripper.
    open_re = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")
    for raw in text.splitlines():
        if terminator is not None:
            if raw.strip() == terminator:
                terminator = None
            continue
        stripped = raw.strip()
        if stripped.startswith("#"):
            continue
        m = open_re.search(raw)
        # `<<<` is a here-STRING, not a here-doc: it has no body to skip.
        if m and "<<<" not in raw:
            terminator = m.group(2)
        # inline comment, only when clearly a comment (space-hash-space)
        line = re.sub(r"\s#\s.*$", "", raw)
        # Join backslash line-continuations so a single COMMAND is a single
        # line: otherwise `pip install ... \` and its wheel argument look like
        # two unrelated statements to the assertions below.
        if out and out[-1].rstrip().endswith("\\"):
            out[-1] = out[-1].rstrip()[:-1].rstrip() + " " + line.strip()
        else:
            out.append(line)
    return "\n".join(out)


def main():
    print("test_release_preflight.py — static analysis of %s" % REL)

    # ---- 1. present, executable, parses -----------------------------------
    if not os.path.isfile(SCRIPT):
        print("FAIL: script not found at %s" % SCRIPT)
        return 1
    mode = os.stat(SCRIPT).st_mode
    check(bool(mode & stat.S_IXUSR), "executable bit set for the owner",
          "mode is %s" % oct(stat.S_IMODE(mode)))
    check(os.access(SCRIPT, os.X_OK), "os.access(X_OK) agrees")

    with open(SCRIPT, encoding="utf-8") as fh:
        text = fh.read()

    # `bash -n` PARSES the script and executes nothing.
    proc = subprocess.run(["bash", "-n", SCRIPT],
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          universal_newlines=True)
    check(proc.returncode == 0, "bash -n parses cleanly", proc.stdout.strip())

    check(text.startswith("#!"), "has a shebang")
    check("SUPERVISOR-ONLY" in text, "SUPERVISOR-ONLY marker present")

    # ---- 2. safe shell ----------------------------------------------------
    check("set -euo pipefail" in text, "set -euo pipefail present")

    stripped = strip_comments_and_heredocs(text)
    # Sanity: the stripper must not have eaten the script. If it did, every
    # FORBIDDEN assertion below would pass vacuously.
    check(len(stripped) > 0.25 * len(text),
          "stripper kept the executable body (%d of %d chars)"
          % (len(stripped), len(text)))
    check("mktemp -d" in stripped, "stripper kept real command lines (mktemp -d)")
    # ...and it must actually have removed something (the header comment).
    check("WHY THIS SCRIPT EXISTS" in text
          and "WHY THIS SCRIPT EXISTS" not in stripped,
          "stripper removed comment prose")

    # ---- 3. no publish-adjacent power -------------------------------------
    for pattern, why in FORBIDDEN:
        hits = [line.strip() for line in stripped.splitlines()
                if re.search(pattern, line)]
        check(not hits, "no %s" % why, "found: %s" % ("; ".join(hits[:3])))

    # ---- 4. offline install of the named wheel ----------------------------
    installs = [line.strip() for line in stripped.splitlines()
                if re.search(r"\bpip\s+install\b", line)]
    check(len(installs) == 1, "exactly one pip install",
          "found %d: %s" % (len(installs), installs))
    if installs:
        check("--no-index" in installs[0],
              "the pip install carries --no-index (offline, local wheel only)",
              installs[0])
        check('"$WHEEL"' in installs[0] or "$WHEEL" in installs[0],
              "the pip install installs the wheel named on the command line",
              installs[0])
    check("python3 -m venv" in stripped, "creates a throwaway venv (python3 -m venv)")
    check("unset PYTHONPATH" in stripped,
          "takes the repo off PYTHONPATH before asserting")
    check(re.search(r"trap\s+'rm -rf", stripped) is not None,
          "cleans up its temp dirs via a trap")

    # ---- 5. all seven checks present --------------------------------------
    for num, name in EXPECTED_CHECKS:
        token = "%d %s" % (num, name)
        check(token in stripped, "check %s is present" % token)
    # and the PASS/FAIL reporting shape the contract specifies
    check("PASS %s %s" in text, "prints PASS <n> <name>")
    check("FAIL %s %s" in text, "prints FAIL <n> <name>")
    # a stray eighth check id would mean the contract drifted
    ids = sorted(set(int(m) for m in re.findall(r"\b(?:ok|fail)\s+([0-9]+)\s",
                                                stripped)))
    check(ids == [n for n, _ in EXPECTED_CHECKS],
          "exactly the seven contract check ids are reported", "found %s" % ids)

    # ---- 6. reads no repo fixture -----------------------------------------
    for repo_path in ("fixtures/", "corpus/", "golden/", "www/"):
        check(repo_path not in stripped,
              "does not read the repo's %s tree" % repo_path)
    check("<<'CIIGOOD'" in text,
          "writes its CII invoice inline (here-doc), not from the repo")

    # ---- 7. the artifacts check 2 asserts on are really shipped -----------
    # REUSE the wheel-declared image builder — do not write a second one.
    import test_wheel_self_report as wsr

    tmp = tempfile.mkdtemp(prefix="einvoice-preflight-image-")
    try:
        image = wsr.build_install_image(tmp)
        pkg = os.path.join(image, "einvoice")
        for artifact in ("remediation_catalog.json", "attestation.json"):
            check(os.path.isfile(os.path.join(pkg, artifact)),
                  "%s IS in the wheel-declared install image" % artifact,
                  "preflight check 2 would assert on a file we do not ship")
            check(artifact in stripped,
                  "preflight actually asserts on %s" % artifact)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)

    if FAILURES:
        print("FAIL: %d assertion(s) failed: %s" % (len(FAILURES), "; ".join(FAILURES)))
        return 1
    print("PASS: %s static safety + shipped-artifact checks all hold" % REL)
    return 0


if __name__ == "__main__":
    sys.exit(main())

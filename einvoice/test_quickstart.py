#!/usr/bin/env python3
"""test_quickstart.py — prove QUICKSTART.md is factual, end-to-end.

This test PARSES the shell commands out of QUICKSTART.md (fenced ```sh blocks)
and runs the real ones against the live engine, so the doc cannot drift from
what the tool actually does. It asserts:

  * the VALID fixture (fixed.xml) exits 0;
  * the BROKEN fixture (broken.xml) exits non-zero AND the printed output names
    the expected rule id (BR-DE-2);
  * the `--json` invocation prints valid JSON whose documented keys are present
    and whose `valid` boolean is consistent with the exit code;
  * the doc also references the pip-installed console-script form
    (`einvoice validate …`) and states pyproject pins zero dependencies — the
    console script can't be run zero-dep in this harness (nothing is installed),
    so we assert the equivalent `python3 einvoice.py …` path AND the doc text
    for that form instead of silently skipping it.

Plain python3: stdlib only, offline, no pytest. Exits 1 on the first failed
assertion (repo style).
"""

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DOC = os.path.join(HERE, "QUICKSTART.md")
WRAPPER = os.path.join(HERE, "einvoice.py")

# The offending fatal rule the broken fixture must name (first fatal reported).
EXPECTED_RULE = "BR-DE-2"
VALID_FIXTURE = "fixed.xml"
BROKEN_FIXTURE = "broken.xml"

# Keys the documented `validate --json` object must carry (per README §3 CLI
# contract / REPORT-SCHEMA.md — we check presence, we do not restate the schema).
JSON_KEYS = {
    "source",
    "valid",
    "violation_count",
    "violations",
    "syntax_bindings",
    "syntax_binding_fatal_count",
    "syntax_binding_warning_count",
}


def fail(msg):
    print("FAIL:", msg)
    sys.exit(1)


def read_doc():
    if not os.path.isfile(DOC):
        fail("QUICKSTART.md does not exist at %s" % DOC)
    with open(DOC, encoding="utf-8") as fh:
        return fh.read()


def parse_sh_blocks(text):
    """Return the list of lines inside every ```sh fenced code block."""
    blocks = re.findall(r"```sh\n(.*?)```", text, re.DOTALL)
    if not blocks:
        fail("QUICKSTART.md has no ```sh fenced command blocks to verify")
    lines = []
    for block in blocks:
        for raw in block.splitlines():
            line = raw.strip()
            if line and not line.startswith("#"):
                lines.append(line)
    return lines


def strip_shell_tail(cmd):
    """Drop a trailing `; echo ...` diagnostic so we run just the invocation."""
    return cmd.split(";", 1)[0].strip()


def run(cmd):
    """Run a shell command line from the doc, cwd = einvoice/ dir."""
    proc = subprocess.run(
        cmd,
        shell=True,
        cwd=HERE,
        capture_output=True,
        text=True,
        timeout=120,
    )
    return proc


def main():
    text = read_doc()
    lines = parse_sh_blocks(text)

    # Pull the runnable checkout-form invocations verbatim from the doc.
    wrapper_cmds = [
        strip_shell_tail(ln)
        for ln in lines
        if ln.startswith("python3 einvoice.py validate")
    ]
    if not wrapper_cmds:
        fail("QUICKSTART.md has no `python3 einvoice.py validate ...` command")

    # De-duplicate while preserving order (the echo-$? variant collapses onto
    # the plain one after strip_shell_tail).
    seen = set()
    cmds = []
    for c in wrapper_cmds:
        if c not in seen:
            seen.add(c)
            cmds.append(c)

    valid_ran = broken_ran = json_ran = False

    for cmd in cmds:
        is_json = "--json" in cmd
        on_valid = VALID_FIXTURE in cmd
        on_broken = BROKEN_FIXTURE in cmd
        if not (on_valid or on_broken):
            fail("documented command references neither fixture: %r" % cmd)

        proc = run(cmd)

        if on_valid:
            valid_ran = True
            if proc.returncode != 0:
                fail(
                    "valid fixture must exit 0, got %d for %r\nstderr: %s"
                    % (proc.returncode, cmd, proc.stderr)
                )
        if on_broken:
            broken_ran = True
            if proc.returncode == 0:
                fail("broken fixture must exit non-zero, got 0 for %r" % cmd)
            combined = proc.stdout + proc.stderr
            if EXPECTED_RULE not in combined:
                fail(
                    "broken fixture output must name %s; not found in %r output:\n%s"
                    % (EXPECTED_RULE, cmd, combined)
                )

        if is_json:
            json_ran = True
            try:
                obj = json.loads(proc.stdout)
            except json.JSONDecodeError as exc:
                fail("--json output is not valid JSON for %r: %s" % (cmd, exc))
            missing = JSON_KEYS - set(obj)
            if missing:
                fail("--json output missing documented keys %s for %r" % (missing, cmd))
            if not isinstance(obj["valid"], bool):
                fail("--json `valid` must be a bool, got %r" % (obj["valid"],))
            # Exit-code contract: valid:true <=> exit 0, valid:false <=> exit 1.
            if obj["valid"] and proc.returncode != 0:
                fail("--json valid:true but exit %d (%r)" % (proc.returncode, cmd))
            if (not obj["valid"]) and proc.returncode == 0:
                fail("--json valid:false but exit 0 (%r)" % cmd)

    if not valid_ran:
        fail("QUICKSTART.md never validates the valid fixture (%s)" % VALID_FIXTURE)
    if not broken_ran:
        fail("QUICKSTART.md never validates the broken fixture (%s)" % BROKEN_FIXTURE)
    if not json_ran:
        fail("QUICKSTART.md never demonstrates the `--json` path")

    # The console-script form can't be run zero-dep here (nothing pip-installed),
    # so instead assert the doc documents it AND the equivalent wrapper path we
    # DID run above — never a silent skip.
    if not re.search(r"(^|[`\s])einvoice validate\b", text):
        fail("QUICKSTART.md must reference the console-script form `einvoice validate ...`")
    if "pip install" not in text:
        fail("QUICKSTART.md must document the `pip install` console-script route")
    if not re.search(r"zero (runtime )?dep", text, re.IGNORECASE):
        fail("QUICKSTART.md must state pyproject pins zero dependencies")

    print("ok: QUICKSTART.md commands verified end-to-end (%d invocation(s))" % len(cmds))
    return 0


if __name__ == "__main__":
    sys.exit(main())

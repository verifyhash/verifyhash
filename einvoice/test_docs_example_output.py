#!/usr/bin/env python3
"""test_docs_example_output.py — the docs' SHOWN output still matches the engine.

`test_quickstart.py` already proves the QUICKSTART commands *run* and name the
right rule. This test is the stricter, complementary drift guard: it pins the
literal OUTPUT BLOCKS the doc puts on the page — the `PASS: …` / `FAIL: …`
summaries and the full `--json` object — against what the real engine emits
today, character for character.

How it stays honest (no parallel copy of the doc text lives here):

  * It reads QUICKSTART.md and walks its fenced blocks IN ORDER. Whenever a
    ```sh command block is immediately followed by a ```text or ```json block,
    that pair is a "command → shown output" claim the doc is making.
  * For every such pair whose command validates a COMMITTED fixture through the
    real engine (`python3 einvoice.py validate …`, the same CLI entrypoint
    `einvoice.cli:main` the other tests drive), it runs the command verbatim
    from the doc and asserts stdout equals the shown block.
      - byte-exact when the block is a full literal (the default here);
      - line-subset (each shown non-ellipsis line present, in order) when the
        block is abridged with a `...` / `…` line. None of the currently
        covered blocks are abridged, but the mode is implemented so an
        abridged block added later is still checked, not silently passed.
  * Both the command AND the expected block are parsed straight out of the .md,
    so the test fails if EITHER the doc block or the engine output drifts.

Path-invariance: the doc runs everything with relative fixture paths from the
einvoice/ dir, so no output line should leak $HOME, the absolute repo path, or
the running username. That is asserted for every captured output.

The covered doc blocks are recorded in COVERED (printed on success) so it is
obvious which claims are pinned and which command→output pairs bind a fixture.

Plain python3: stdlib only, offline, no pytest. Exits 1 on the first failed
assertion (repo style).
"""

import getpass
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DOC = os.path.join(HERE, "QUICKSTART.md")

# A pair is only pinned if its command validates one of these committed
# fixtures (relative paths, exactly as the doc writes them).
FIXTURES = (
    "examples/01-missing-fields/fixed.xml",
    "examples/01-missing-fields/broken.xml",
)


def fail(msg):
    print("FAIL:", msg)
    sys.exit(1)


def read_doc():
    if not os.path.isfile(DOC):
        fail("QUICKSTART.md does not exist at %s" % DOC)
    with open(DOC, encoding="utf-8") as fh:
        return fh.read()


# ---- markdown fence walker -------------------------------------------------
# Capture (info-string, body) for every fenced block, in document order. The
# body is the text between the opening "```<info>\n" and the closing "```",
# and INCLUDES the trailing newline that precedes the closing fence — which is
# exactly the trailing newline the engine's own stdout carries, so a full
# literal block compares byte-for-byte against captured-body.
FENCE_RE = re.compile(r"```([^\n`]*)\n(.*?)```", re.DOTALL)


def parse_blocks(text):
    blocks = []
    for m in FENCE_RE.finditer(text):
        info = m.group(1).strip()
        body = m.group(2)
        blocks.append((info, body))
    if not blocks:
        fail("QUICKSTART.md has no fenced code blocks")
    return blocks


def command_from_sh_block(body):
    """Return the single runnable `validate` invocation in an sh block, or None.

    Skips comment lines and any line carrying a `; echo …` diagnostic tail
    (those exit-code demo lines are never the ones with a shown output block).
    """
    found = None
    for raw in body.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if not line.startswith("python3 einvoice.py validate"):
            continue
        if ";" in line:  # e.g. `… ; echo "exit=$?"` — not an output-bound cmd
            continue
        if found is not None:
            # More than one candidate in a single block: ambiguous, refuse to
            # guess which one the following output block belongs to.
            return None
        found = line
    return found


def binds_fixture(cmd):
    for fx in FIXTURES:
        if fx in cmd:
            return fx
    return None


def collect_pairs(blocks):
    """Command→output pairs: an sh block immediately followed by text/json."""
    pairs = []
    for i in range(len(blocks) - 1):
        info, body = blocks[i]
        if info != "sh":
            continue
        nxt_info, nxt_body = blocks[i + 1]
        if nxt_info not in ("text", "json"):
            continue
        cmd = command_from_sh_block(body)
        if cmd is None:
            continue
        fx = binds_fixture(cmd)
        if fx is None:
            continue
        pairs.append((cmd, nxt_info, nxt_body, fx))
    return pairs


def run(cmd):
    return subprocess.run(
        cmd,
        shell=True,
        cwd=HERE,
        capture_output=True,
        text=True,
        timeout=120,
    )


def is_abridged(body):
    for raw in body.splitlines():
        if raw.strip() in ("...", "…"):
            return True
    return False


def assert_byte_exact(cmd, expected, actual):
    if actual != expected:
        # Show the first differing line to make drift obvious.
        exp_lines = expected.splitlines()
        act_lines = actual.splitlines()
        diff_at = None
        for idx in range(max(len(exp_lines), len(act_lines))):
            e = exp_lines[idx] if idx < len(exp_lines) else "<no line>"
            a = act_lines[idx] if idx < len(act_lines) else "<no line>"
            if e != a:
                diff_at = (idx + 1, e, a)
                break
        detail = ""
        if diff_at:
            detail = "\n  first diff at line %d:\n    doc:    %r\n    engine: %r" % diff_at
        fail(
            "shown output DRIFTED from engine for %r%s\n--- doc block ---\n%s\n--- engine stdout ---\n%s"
            % (cmd, detail, expected, actual)
        )


def assert_line_subset(cmd, expected, actual):
    """Every shown non-ellipsis line must appear, in order, in actual stdout."""
    shown = [ln for ln in expected.splitlines() if ln.strip() not in ("...", "…")]
    act_lines = actual.splitlines()
    pos = 0
    for want in shown:
        while pos < len(act_lines) and act_lines[pos] != want:
            pos += 1
        if pos >= len(act_lines):
            fail(
                "abridged doc line not found (in order) in engine output for %r:\n  missing: %r\n--- engine stdout ---\n%s"
                % (cmd, want, actual)
            )
        pos += 1


def assert_no_path_leak(cmd, actual):
    home = os.path.expanduser("~")
    user = getpass.getuser()
    leaks = []
    if home and home in actual:
        leaks.append("$HOME (%s)" % home)
    if HERE in actual:
        leaks.append("absolute repo path (%s)" % HERE)
    if user and re.search(r"\b%s\b" % re.escape(user), actual):
        leaks.append("username (%s)" % user)
    if leaks:
        fail(
            "engine output for %r leaks host paths/identity: %s\n--- stdout ---\n%s"
            % (cmd, ", ".join(leaks), actual)
        )


def main():
    text = read_doc()
    blocks = parse_blocks(text)
    pairs = collect_pairs(blocks)

    if not pairs:
        fail(
            "found no `sh command → text/json output` pair binding a committed "
            "fixture in QUICKSTART.md — nothing to pin (doc structure changed?)"
        )

    # Sanity: the covered set must include the valid summary, the fail summary,
    # and the --json object — the three claims this guard exists to protect.
    saw_pass = saw_fail = saw_json = False
    covered = []

    for cmd, kind, body, fx in pairs:
        proc = run(cmd)

        # Every doc command must actually succeed as an invocation (exit code
        # is its own contract, checked in test_quickstart; here we just refuse
        # to compare against a crashed/usage-error run).
        if proc.returncode not in (0, 1):
            fail(
                "doc command exited %d (not a validate outcome) for %r\nstderr: %s"
                % (proc.returncode, cmd, proc.stderr)
            )

        assert_no_path_leak(cmd, proc.stdout)

        if is_abridged(body):
            assert_line_subset(cmd, body, proc.stdout)
            mode = "line-subset"
        else:
            assert_byte_exact(cmd, body, proc.stdout)
            mode = "byte-exact"

        if kind == "json":
            saw_json = True
        elif proc.stdout.startswith("PASS:"):
            saw_pass = True
        elif proc.stdout.startswith("FAIL:"):
            saw_fail = True

        covered.append("  [%s/%s] %s  (fixture: %s)" % (kind, mode, cmd, fx))

    if not saw_pass:
        fail("no covered pair pins the PASS: summary block (valid fixture)")
    if not saw_fail:
        fail("no covered pair pins the FAIL: summary block (broken fixture)")
    if not saw_json:
        fail("no covered pair pins the --json output block")

    print("ok: QUICKSTART.md shown output matches the real engine (%d pair(s))" % len(pairs))
    for line in covered:
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())

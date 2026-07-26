#!/usr/bin/env python3
"""test_docs_example_output.py — the docs' SHOWN output still matches the engine.

`test_quickstart.py` already proves the QUICKSTART commands *run* and name the
right rule. This test is the stricter, complementary drift guard: it pins the
literal OUTPUT BLOCKS the walkthroughs put on the page — the `PASS: …` /
`FAIL: …` summaries and the full `--json` object — against what the real engine
emits today, character for character.

How it stays honest (no parallel copy of the doc text lives here):

  * It reads every document in DOCS and walks its fenced blocks IN ORDER.
    Whenever a ```sh command block is immediately followed by a ```text or
    ```json block, that pair is a "command → shown output" claim.
  * A pair is pinned when its command validates an input this test can
    reproduce, through the real engine (the same CLI entrypoint
    `einvoice.cli:main` the other tests drive). There are two such kinds:
      - COMMITTED FIXTURES (see FIXTURES): run verbatim from einvoice/.
      - DOC-CREATED FIXTURES (see DOC_CREATED_FIXTURES): the walkthrough builds
        its own input on the page with a `cat > x <<'XML' … XML` heredoc and
        sometimes derives a second file from it with `sed … > y`. Those blocks
        are replayed, in document order, inside a `tempfile.TemporaryDirectory`
        OUTSIDE the repo — exactly what a stranger copy-pasting the page does —
        and the shown block is compared against that run's stdout.
  * Comparison is byte-exact when the block is a full literal (the default
    here); line-subset (each shown non-ellipsis line present, in order) when
    the block is abridged with a `...` / `…` line. None of the currently
    covered blocks are abridged, but the mode is implemented so an abridged
    block added later is still checked, not silently passed.
  * Both the command AND the expected block are parsed straight out of the .md,
    so the test fails if EITHER the doc block or the engine output drifts.

Why the doc-created half exists: QUICKSTART.md §4 ("Break it → exit 1") shipped
a `FAIL:` block that was missing the engine's `N finding(s) total: …` line,
because its input (`invoice.xml` → `broken.xml`) is built by the page itself and
therefore matched no committed fixture, so nothing here looked at it. Any doc
block whose input the page creates is now pinned too.

Path-invariance: the docs run everything with relative paths (from einvoice/,
or from the scratch dir they build), so no output line should leak $HOME, the
absolute repo path, or the running username. That is asserted for every
captured output, temp-dir captures included.

Every command→output pair found is recorded in COVERED (printed on success),
pinned ones with their mode and bound input, and pairs matching none of the
declared shapes as `SKIPPED (<reason>)` — so the coverage boundary is visible
rather than implied.

Plain python3: stdlib only, offline, no pytest. Exits 1 on the first failed
assertion (repo style).
"""

import getpass
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------------------
# DOCS — the walkthrough documents this guard drives, and the claim kinds each
# one MUST still pin. A doc losing its pinned claim is itself a failure (that
# is how "someone deleted the interesting block" gets caught).
#   "pass" — a `PASS: …` summary block
#   "fail" — a `FAIL: …` summary block
#   "json" — a ```json report block
# ---------------------------------------------------------------------------
DOCS = (
    # The English walkthrough: install → sample invoice → validate → break it →
    # --json, plus the same walk in raw CII and the repository-checkout variant.
    ("QUICKSTART.md", ("pass", "fail", "json")),
    # The German walkthrough — the ONLY German copy-paste path we ship, and the
    # first page the German-mandate buyer pool runs. It shows one FAIL summary
    # (committed fixture); it has no PASS or ```json output block of its own,
    # it points at QUICKSTART.md for those.
    ("QUICKSTART.de.md", ("fail",)),
)

# A pair is pinned "from the repo" if its command validates one of these
# COMMITTED fixtures (relative paths, exactly as the docs write them).
FIXTURES = (
    "examples/01-missing-fields/fixed.xml",
    "examples/01-missing-fields/broken.xml",
)

# ---------------------------------------------------------------------------
# DOC_CREATED_FIXTURES — the shapes a walkthrough uses to build its OWN input.
# A shell line inside a ```sh block is replayable only if it matches one of
# these (anything else makes the whole block unreplayable, and any pair that
# depends on it is reported SKIPPED rather than silently passed):
#
#   "heredoc"  cat > invoice.xml <<'XML'      creates a file from the literal
#              <?xml …>                       lines that follow, up to the
#              XML                            terminator line. Quoted delimiter
#                                             ⇒ no shell expansion inside.
#   "sed"      sed '/BuyerReference/d' invoice.xml > broken.xml
#                                             derives a second file from one
#                                             created earlier on the page.
#
# Both name plain relative filenames (no slashes, no globs, no variables), so
# replaying them can only ever write inside the scratch directory.
# ---------------------------------------------------------------------------
NAME = r"[A-Za-z0-9][A-Za-z0-9._-]*"
DOC_CREATED_FIXTURES = (
    ("heredoc", re.compile(r"^cat > (?P<name>%s) <<'(?P<term>[A-Za-z]+)'$" % NAME)),
    ("sed", re.compile(r"^sed '[^']*' (?P<src>%s) > (?P<name>%s)$" % (NAME, NAME))),
)
HEREDOC_RE = DOC_CREATED_FIXTURES[0][1]
SED_RE = DOC_CREATED_FIXTURES[1][1]

# The docs write the installed console script (`einvoice validate …`). This
# test drives the checkout entrypoint the rest of the suite drives
# (`einvoice.py`, i.e. `einvoice.cli:main`) instead of requiring an installed
# script on PATH — one documented rewrite of the leading token only, never a
# rewrite of the doc's flags, arguments or ordering. (That the console-script
# spelling itself works is `test_doc_commands_from_wheel.py`'s job, from a
# built wheel; this normalizer does not weaken that.)
CHECKOUT_ENTRY = "python3 einvoice.py"
ABS_ENTRY = "python3 " + os.path.join(HERE, "einvoice.py")
VALIDATE_RE = re.compile(r"^python3 einvoice\.py validate .+$")
ECHO_TAIL = '; echo "exit=$?"'


def fail(msg):
    print("FAIL:", msg)
    sys.exit(1)


def read_doc(path):
    if not os.path.isfile(path):
        fail("%s does not exist" % path)
    with open(path, encoding="utf-8") as fh:
        return fh.read()


# ---- markdown fence walker -------------------------------------------------
# Capture (info-string, body) for every fenced block, in document order. The
# body is the text between the opening "```<info>\n" and the closing "```",
# and INCLUDES the trailing newline that precedes the closing fence — which is
# exactly the trailing newline the engine's own stdout carries, so a full
# literal block compares byte-for-byte against captured-body.
FENCE_RE = re.compile(r"```([^\n`]*)\n(.*?)```", re.DOTALL)


def parse_blocks(name, text):
    blocks = []
    for m in FENCE_RE.finditer(text):
        info = m.group(1).strip()
        body = m.group(2)
        blocks.append((info, body))
    if not blocks:
        fail("%s has no fenced code blocks" % name)
    return blocks


def normalize_entry(line):
    """Map the doc's console-script spelling onto the checkout entrypoint."""
    if line.startswith("einvoice "):
        return CHECKOUT_ENTRY + line[len("einvoice"):]
    return line


def command_from_sh_block(body):
    """Return the single runnable `validate` invocation in an sh block, or None.

    Skips comment lines and any line carrying a `; echo …` diagnostic tail
    (those exit-code demo lines are never the ones with a shown output block).
    """
    found = None
    for raw in body.splitlines():
        line = normalize_entry(raw.strip())
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


# ---- doc-created-fixture replay --------------------------------------------


def classify_sh_block(body):
    """Parse an ```sh block against DOC_CREATED_FIXTURES.

    Returns (creates, uses, setup_text, full_text) where
      creates    — filenames this block writes (heredoc + sed targets)
      uses       — bare filenames a `validate` line in this block reads
      setup_text — shell text of the creation lines only
      full_text  — shell text of the whole block, entrypoint-normalized
    Returns None the moment a line matches none of the declared shapes, so an
    unknown command can never be executed nor silently treated as covered.
    """
    lines = body.splitlines()
    creates, uses = [], []
    setup, full = [], []
    i = 0
    while i < len(lines):
        raw = lines[i]
        line = raw.strip()
        if not line or line.startswith("#"):
            i += 1
            continue

        m = HEREDOC_RE.match(line)
        if m:
            term = m.group("term")
            chunk = [raw]
            i += 1
            closed = False
            while i < len(lines):
                chunk.append(lines[i])
                if lines[i].strip() == term:
                    closed = True
                    i += 1
                    break
                i += 1
            if not closed:
                return None  # unterminated heredoc: refuse to run anything
            creates.append(m.group("name"))
            setup.extend(chunk)
            full.extend(chunk)
            continue

        m = SED_RE.match(line)
        if m:
            creates.append(m.group("name"))
            setup.append(line)
            full.append(line)
            i += 1
            continue

        cmd = normalize_entry(line)
        tail = ""
        if cmd.endswith(ECHO_TAIL):
            cmd, tail = cmd[: -len(ECHO_TAIL)], ECHO_TAIL
        if ";" in cmd or ">" in cmd or "|" in cmd or "&" in cmd:
            return None  # redirects/pipes: not a plain shown-output command
        if not VALIDATE_RE.match(cmd):
            return None  # anything else (pip install, --explain, …)
        # bare relative filenames only — committed fixtures carry a "/"
        uses.extend(tok for tok in cmd.split()[3:] if "." in tok and "/" not in tok)
        full.append(cmd + tail)
        i += 1

    return creates, uses, "\n".join(setup), "\n".join(full)


def run(cmd, cwd):
    return subprocess.run(
        cmd,
        shell=True,
        cwd=cwd,
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


def compare(cmd, body, stdout):
    """Byte-exact, or line-subset for an abridged block. Returns the mode."""
    if is_abridged(body):
        assert_line_subset(cmd, body, stdout)
        return "line-subset"
    assert_byte_exact(cmd, body, stdout)
    return "byte-exact"


def check_returncode(cmd, proc):
    # Every doc command must actually succeed as an invocation (exit code is
    # its own contract, checked in test_quickstart; here we just refuse to
    # compare against a crashed/usage-error run). Blocks ending in
    # `; echo "exit=$?"` report the echo's status, which is 0.
    if proc.returncode not in (0, 1):
        fail(
            "doc command exited %d (not a validate outcome) for %r\nstderr: %s"
            % (proc.returncode, cmd, proc.stderr)
        )


def claim_kind(kind, stdout):
    if kind == "json":
        return "json"
    if stdout.startswith("PASS:"):
        return "pass"
    if stdout.startswith("FAIL:"):
        return "fail"
    return None


def check_doc(name, required):
    path = os.path.join(HERE, name)
    blocks = parse_blocks(name, read_doc(path))

    covered = []
    pinned = 0
    seen_kinds = set()

    # One scratch directory per document, OUTSIDE the repo: the walkthrough's
    # own files accumulate in it in document order, exactly as they would in a
    # stranger's shell. Created lazily, so a doc with no heredoc costs nothing.
    workspace = None
    created = set()

    try:
        for i, (info, body) in enumerate(blocks):
            if info != "sh":
                continue
            nxt_info, nxt_body = blocks[i + 1] if i + 1 < len(blocks) else ("", "")
            is_pair = nxt_info in ("text", "json")

            shaped = classify_sh_block(body)

            # --- replay path: blocks that build and use the doc's own input ---
            if shaped is not None:
                creates, uses, setup_text, full_text = shaped
                if creates or created.intersection(uses):
                    if workspace is None:
                        workspace = tempfile.TemporaryDirectory(prefix="einvoice-doc-")
                    wdir = workspace.name

                    missing = [u for u in uses if u not in created and u not in creates]

                    if is_pair and uses and not missing:
                        # A pair whose input this page builds: replay the whole
                        # block (creations included) and pin the shown output.
                        proc = run(full_text.replace(CHECKOUT_ENTRY, ABS_ENTRY), wdir)
                        check_returncode(full_text, proc)
                        assert_no_path_leak(full_text, proc.stdout)
                        if wdir in proc.stdout:
                            fail(
                                "%s: replayed output leaks the scratch dir path\n%s"
                                % (name, proc.stdout)
                            )
                        mode = compare(full_text, nxt_body, proc.stdout)
                        created.update(creates)
                        pinned += 1
                        k = claim_kind(nxt_info, proc.stdout)
                        if k:
                            seen_kinds.add(k)
                        covered.append(
                            "  [%s/%s] %s  (doc-created: %s)"
                            % (
                                nxt_info,
                                mode,
                                " && ".join(
                                    ln
                                    for ln in full_text.splitlines()
                                    if not ln.startswith("<")
                                ),
                                ", ".join(uses),
                            )
                        )
                        continue

                    # Nothing to compare through the replay (setup-only block,
                    # or a doc command with no shown output block): replay just
                    # the creations so the scratch dir stays in step with the
                    # page, then let the committed-fixture path below decide.
                    if setup_text:
                        proc = run(setup_text, wdir)
                        if proc.returncode != 0:
                            fail(
                                "%s: replaying a doc setup block failed (%d)\n%s"
                                % (name, proc.returncode, proc.stderr)
                            )
                    created.update(creates)
                    if is_pair and missing:
                        covered.append(
                            "  SKIPPED (input %s not created by this page) %r"
                            % (", ".join(missing), full_text.splitlines()[-1][:70])
                        )
                        continue

            if not is_pair:
                continue

            # --- committed-fixture path (unchanged) --------------------------
            cmd = command_from_sh_block(body)
            if cmd is None:
                covered.append(
                    "  SKIPPED (no single runnable validate command) %r"
                    % body.splitlines()[0][:70]
                )
                continue
            fx = binds_fixture(cmd)
            if fx is None:
                covered.append("  SKIPPED (binds no committed fixture) %r" % cmd)
                continue

            proc = run(cmd, HERE)
            check_returncode(cmd, proc)
            assert_no_path_leak(cmd, proc.stdout)
            mode = compare(cmd, nxt_body, proc.stdout)
            pinned += 1
            k = claim_kind(nxt_info, proc.stdout)
            if k:
                seen_kinds.add(k)
            covered.append("  [%s/%s] %s  (fixture: %s)" % (nxt_info, mode, cmd, fx))
    finally:
        if workspace is not None:
            workspace.cleanup()

    if not pinned:
        fail(
            "found no `sh command → text/json output` pair binding a "
            "reproducible input in %s — nothing to pin (doc structure changed?)"
            % name
        )
    for want in required:
        if want not in seen_kinds:
            fail("no covered pair in %s pins the %s claim" % (name, want.upper()))

    return pinned, covered


def main():
    total = 0
    report = []
    for name, required in DOCS:
        pinned, covered = check_doc(name, required)
        total += pinned
        report.append("%s — %d pinned pair(s)" % (name, pinned))
        report.extend(covered)

    print(
        "ok: shown output in %d walkthrough(s) matches the real engine (%d pinned pair(s))"
        % (len(DOCS), total)
    )
    for line in report:
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())

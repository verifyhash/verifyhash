#!/usr/bin/env python3
"""test_site_command_truth.py — the commands the generated SITE teaches must be
commands the shipped CLI actually accepts, and any snippet that needs the
repository checkout must SAY SO in prose the reader sees.

WHY THIS EXISTS (the measured defect class, T-VHERG.9)
-----------------------------------------------------
Until this test, `test_doc_commands_from_wheel.py` guarded the four Markdown
docs (QUICKSTART.md / README.md / REPORT-FORMATS.md / EXIT-CODES.md) and
nothing guarded the generated HTML. So the two worked-walkthrough pages — the
pages the announce sends a first-time evaluator to — taught

    python3 -m einvoice.report examples/01-missing-fields/broken.xml --format json

as the FIRST command a stranger copies. Two things were wrong with that and
neither had a guard:

  * `examples/01-missing-fields/` is deliberately NOT in the PyPI wheel (see
    test_wheel_self_report.py), and the pages never said so, so a reader who
    followed the advertised `pip install verifyhash-einvoice` on-ramp got
    `No such file or directory` on their very first run;
  * the polished `einvoice` console script that install puts on their PATH was
    never shown at all — not once, on any of the three pages.

This file closes that class for the three pages T-VHERG.9 touches. It is
STRUCTURAL, not a wording pin: it derives the accepted subcommand and flag
vocabulary from `einvoice.cli`'s OWN structures, so renaming a subcommand or
dropping a flag from the CLI breaks this test rather than silently leaving the
site advertising something the binary refuses.

WHAT IS ASSERTED
----------------
(1) CONSOLE SCRIPT TAUGHT: each page shows the `einvoice` console script at
    least once, on a real command line inside a <pre> block.
(2) CHECKOUT LABELLING: any <pre> block whose text mentions `examples/` sits on
    a page whose RENDERED prose carries the checkout phrase — the same literal
    convention test_doc_commands_from_wheel.py defines ("repository checkout",
    case-insensitive), with the German page matching the German rendering the
    German product page already uses ("Repository-Checkout"). An HTML comment
    would not count: the phrase is looked for in tag-stripped, unescaped text.
(3) SUBCOMMAND TRUTH: the first token after `einvoice` on a shown command line
    must be a member of `einvoice.cli.COMMAND_SURFACE` — the CLI's own
    documentation tuple, read at runtime, never retyped here.
(4) FLAG TRUTH: every `--flag` on a shown `einvoice` command line must be one
    that THAT subcommand accepts, derived by parsing `einvoice.cli.USAGE` —
    the CLI's own synopsis, one line per subcommand. Deleting a flag from the
    synopsis (or from a subcommand's line) fails this test.

SCOPE, and why it is exactly three files
----------------------------------------
`PAGES` below is the set T-VHERG.9 rewrote: the landing, the English
walkthrough and the German walkthrough. The other page families already have
their own guards and are deliberately NOT re-checked here — www/rules/* and
www/de/index.html by test_site.py (which byte-pins the German page's commands
to QUICKSTART.md / ci/README.md via gen_site.DE_COMMANDS), www/validate/* by
test_site.py's validate-page section, and the Markdown docs by
test_doc_commands_from_wheel.py. Widening this file to those pages would
duplicate, not add, coverage.

HONEST LIMITS
-------------
Static inspection only: "the CLI advertises this flag for this subcommand" is
not "this exact invocation exits 0 on your machine". Runtime behaviour of the
walkthrough's commands is proven by test_walkthrough.py (which re-runs the live
engine) and test_quickstart.py. Lines inside <pre> that are not command lines
(the invoice XML, the unified diff) are ignored by construction: a line counts
only when its program token is `einvoice`.

Stdlib only, offline, no pip, no network, well under a second.

Run from the einvoice dir:  python3 test_site_command_truth.py

Plain python3, no pytest. Exits 1 on the first failed check (repo style).
"""

from __future__ import annotations

import html
import os
import re
import shlex
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

from einvoice import cli as _cli   # noqa: E402  (the CLI's OWN structures)

WWW = os.path.join(HERE, "www")

# The three pages T-VHERG.9 owns, each with the checkout phrase its language
# uses. See the "SCOPE" note in the module docstring for why the list stops
# here; every other page family is covered by its own test.
#
# The English phrase is byte-for-byte the MARKER that
# test_doc_commands_from_wheel.py defines for the Markdown docs — one
# convention across docs and site, not two. The German page uses the German
# rendering that www/de/index.html already ships.
PAGES = (
    ("www/index.html", "repository checkout"),
    ("www/walkthrough/index.html", "repository checkout"),
    ("www/de/walkthrough/index.html", "Repository-Checkout"),
)

#: The console script name, read from the wheel's declared entry point rather
#: than typed: `pyproject.toml [project.scripts]`.
SCRIPT_RE = re.compile(r'(?m)^\s*([A-Za-z0-9_.\-]+)\s*=\s*"einvoice\.cli:')

PRE_RE = re.compile(r"<pre\b[^>]*>(.*?)</pre>", re.S | re.I)
TAG_RE = re.compile(r"<[^>]*>")

# ---------------------------------------------------------------------------
# ALLOWLIST — legitimate exceptions, each with its one-line reason. An
# UNDECLARED violation is a hard failure; nothing here is a blanket skip.
#
# Entries are (page, exact command line as rendered, reason). There are none
# today: every `einvoice` command line the three pages show is a plain
# subcommand invocation with flags the CLI's own USAGE synopsis lists. The
# table exists so that a future page needing (say) a deliberately-wrong
# command in an error-handling example must DECLARE it here in the same commit
# rather than quietly loosening the checks above.
# ---------------------------------------------------------------------------
ALLOWLIST = (
    # ("www/index.html", "einvoice frobnicate x.xml", "reason goes here"),
)


def fail(msg):
    print("FAIL:", msg)
    sys.exit(1)


def script_name():
    """The console-script name the wheel declares for `einvoice.cli`."""
    with open(os.path.join(HERE, "pyproject.toml"), encoding="utf-8") as fh:
        m = SCRIPT_RE.search(fh.read())
    if not m:
        fail("pyproject.toml declares no [project.scripts] entry pointing at "
             "einvoice.cli — cannot tell what the console script is called")
    return m.group(1)


def visible_text(page):
    """Rendered, human-visible text: tags removed, then HTML-unescaped.

    Deliberately tag-stripping FIRST: an `<!-- repository checkout -->` comment
    is a tag and therefore vanishes, so an invisible annotation can never
    satisfy the labelling check.
    """
    return html.unescape(TAG_RE.sub(" ", page))


def pre_blocks(page):
    """Visible text of every <pre> block on the page, in document order."""
    return [html.unescape(TAG_RE.sub("", body))
            for body in PRE_RE.findall(page)]


# ---------------------------------------------------------------------------
# The accepted vocabulary — DERIVED from einvoice.cli, never hard-coded
# ---------------------------------------------------------------------------
def accepted_subcommands():
    """The CLI's own documented surface (dispatch set + informational ones)."""
    surface = tuple(_cli.COMMAND_SURFACE)
    if not surface:
        fail("einvoice.cli.COMMAND_SURFACE is empty — nothing to check against")
    # Sanity: the tuple really is the CLI's, not a stale copy — the dispatch
    # subcommands must all be in it.
    for sub in _cli.VALID_SUBCOMMANDS:
        if sub not in surface:
            fail("einvoice.cli.VALID_SUBCOMMANDS member %r missing from "
                 "COMMAND_SURFACE — the CLI's own tuples disagree" % sub)
    return set(surface)


_FLAG_RE = re.compile(r"--[A-Za-z][A-Za-z0-9-]*")


def accepted_flags():
    """``{subcommand: {--flag, ...}}`` parsed from ``einvoice.cli.USAGE``.

    ``USAGE`` is one synopsis line per command form, e.g.::

        usage: einvoice validate <invoice.xml|invoice.pdf|-> [--json] ...
               einvoice receipt --verify <receipt.json> [--json]
               einvoice --explain <RULE-ID> [--lang=en|de]

    so the first token after ``einvoice`` on a line is the subcommand and every
    ``--flag`` on that line (bracketed or not) is one it accepts. Two lines for
    the same subcommand (``receipt`` above) union their flags. The
    informational one-word forms (``--show-config``, ``--version``, ``--help``)
    name themselves as the subcommand and accept nothing further.
    """
    out = {}
    seen_script = False
    for raw in _cli.USAGE.splitlines():
        line = raw.strip()
        if line.startswith("usage:"):
            line = line[len("usage:"):].strip()
        parts = line.split()
        if not parts or parts[0] != "einvoice":
            continue
        seen_script = True
        rest = parts[1:]
        if not rest:
            continue
        sub = rest[0]
        flags = set(_FLAG_RE.findall(" ".join(rest[1:])))
        if sub.startswith("--"):
            # `einvoice --explain <RULE-ID> [--lang=en|de]`: the subcommand IS
            # the flag; it is legal on its own line too.
            flags.add(sub)
        out.setdefault(sub, set()).update(flags)
    if not seen_script:
        fail("einvoice.cli.USAGE names no `einvoice ...` form — the synopsis "
             "parser is not seeing the CLI's structure")
    if "validate" not in out:
        fail("einvoice.cli.USAGE has no `validate` line — refusing to check "
             "the site against an empty vocabulary")
    return out


# ---------------------------------------------------------------------------
# Pulling `einvoice ...` command lines out of a <pre>
# ---------------------------------------------------------------------------
def command_lines(text, script):
    """Yield each line of ``text`` whose program token is the console script.

    A leading shell prompt (``$ ``) is stripped. Everything else in a <pre> —
    the invoice XML, the unified diff, sample output — has some other first
    token and is skipped, so no heuristic guessing is involved.
    """
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("$ "):
            line = line[2:].strip()
        if not line:
            continue
        first = line.split(None, 1)[0]
        if first == script:
            yield line


def check_command(page_rel, line, subcommands, flags_by_sub):
    """Hard-fail unless ``line`` is a command the CLI advertises."""
    for allow_page, allow_line, _reason in ALLOWLIST:
        if allow_page == page_rel and allow_line == line:
            return "allowlisted"
    try:
        tokens = shlex.split(line)
    except ValueError as exc:
        fail("%s: cannot tokenise shown command %r (%s)"
             % (page_rel, line, exc))
    rest = tokens[1:]
    if not rest:
        fail("%s: shows a bare `einvoice` with no subcommand: %r"
             % (page_rel, line))
    sub = rest[0]
    if sub not in subcommands:
        fail("%s: shown command names subcommand %r, which the CLI does NOT "
             "advertise (einvoice.cli.COMMAND_SURFACE = %s): %r"
             % (page_rel, sub, ", ".join(sorted(subcommands)), line))
    accepted = flags_by_sub.get(sub)
    if accepted is None:
        fail("%s: subcommand %r has no line in einvoice.cli.USAGE, so no flag "
             "vocabulary can be derived for it: %r" % (page_rel, sub, line))
    for tok in rest[1:]:
        if not tok.startswith("--"):
            continue
        flag = tok.split("=", 1)[0]
        if flag not in accepted:
            fail("%s: shown command passes %s to `einvoice %s`, which does NOT "
                 "accept it (einvoice.cli.USAGE lists %s): %r"
                 % (page_rel, flag, sub,
                    ", ".join(sorted(accepted)) or "no flags", line))
    return sub


def main():
    script = script_name()
    subcommands = accepted_subcommands()
    flags_by_sub = accepted_flags()

    total_cmds = 0
    checked_pages = 0

    for page_rel, marker in PAGES:
        path = os.path.join(HERE, *page_rel.split("/"))
        if not os.path.isfile(path):
            fail("page missing (run `python3 gen_site.py`): %s" % page_rel)
        with open(path, encoding="utf-8") as fh:
            page = fh.read()
        checked_pages += 1
        vis = visible_text(page)
        blocks = pre_blocks(page)
        if not blocks:
            fail("%s: no <pre> block at all — the page teaches no command"
                 % page_rel)

        # (1) the console script is taught at least once, as a real command.
        page_cmds = []
        for block in blocks:
            page_cmds.extend(command_lines(block, script))
        if not page_cmds:
            fail("%s: shows no `%s ...` command line in any <pre> block — the "
                 "console script a `pip install` puts on PATH is never taught"
                 % (page_rel, script))

        # (2) any block naming examples/ needs the rendered checkout phrase.
        example_blocks = [b for b in blocks if "examples/" in b]
        if example_blocks and marker.lower() not in vis.lower():
            fail("%s: %d <pre> block(s) reference `examples/` (not shipped in "
                 "the wheel) but the page's rendered prose never says %r — a "
                 "wheel-only reader gets 'No such file or directory'"
                 % (page_rel, len(example_blocks), marker))

        # (3) + (4) every shown command is one the CLI advertises.
        for line in page_cmds:
            check_command(page_rel, line, subcommands, flags_by_sub)
            total_cmds += 1

    if checked_pages != len(PAGES):
        fail("checked %d pages, expected %d" % (checked_pages, len(PAGES)))
    if total_cmds < len(PAGES):
        fail("only %d `%s` command line(s) across %d pages — the extractor is "
             "not seeing the pages" % (total_cmds, script, len(PAGES)))

    print("command truth OK: %d `%s` command line(s) across %d page(s); "
          "subcommands checked against einvoice.cli.COMMAND_SURFACE (%d), "
          "flags against einvoice.cli.USAGE (%d command form(s)); %d "
          "allowlisted exception(s)"
          % (total_cmds, script, checked_pages, len(subcommands),
             len(flags_by_sub), len(ALLOWLIST)))
    return 0


if __name__ == "__main__":
    sys.exit(main())

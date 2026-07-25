#!/usr/bin/env python3
"""test_doc_commands_from_wheel.py — every documented command is either
runnable from the INSTALLED WHEEL, or is labelled as needing the repo.

WHY THIS EXISTS
---------------
`verifyhash-einvoice` on PyPI is the advertised primary channel (landing page,
DE page, README, `.pre-commit-hooks.yaml`). The wheel ships ONLY the
`einvoice` package: `examples/`, `corpus/`, `fixtures/`, `einvoice.py`,
`prove.py`, the `gen_*.py` generators and the test suite are deliberately NOT
in it (see `test_wheel_self_report.py` — the data-path sweep is closed and
stays closed). So a stranger who arrives through the funnel's primary link and
copies a command naming `examples/01-missing-fields/fixed.xml` gets
`No such file or directory` on their first-run document.

`test_quickstart.py` proves the doc's commands work *from a checkout*. Nothing
proved anything about the wheel-only reader. This test closes that gap: it
extracts every fenced shell command from the four user-facing CLI docs,
classifies each one against a reconstructed wheel install image, and fails if

  (a) a command we present as wheel-runnable does not actually resolve there
      (its console script / module is missing from the image), or
  (b) a command that needs the repository checkout is NOT labelled as such in
      the doc, so a wheel-only reader would try to run it.

THE ANNOTATION MARKER (one convention, used by all four docs)
-------------------------------------------------------------
A checkout-only command must carry the literal phrase

    repository checkout            (case-insensitive)

either in the prose immediately above its fence (the last 12 non-blank lines
between the previous fence and this one) or in any enclosing Markdown heading
(the heading stack above the fence: the nearest `###`, then the nearest `##`
above that, and so on). A whole "From a repository checkout" section therefore
annotates every fence inside it once, instead of repeating the clause on each
block. The phrase is deliberately plain prose the reader sees rendered — an
invisible HTML comment would satisfy a test while leaving the stranger stuck.

CLASSIFICATION (static inspection only — nothing is executed)
-------------------------------------------------------------
CHECKOUT-ONLY: the command names a REPOSITORY ARTIFACT that the wheel image
does not contain. A token is a repository artifact when

  * it has no `/` and a file/dir of that exact name exists next to this test
    (`einvoice.py`, `prove.py`, `verify_attestation.py`, `pyproject.toml`), or
  * it has `/` and the token — or any tail of it with >= 2 path segments —
    exists in the source tree (`examples/01-missing-fields/fixed.xml`; and
    `third_party/einvoice/ci/validate-invoices.sh`, whose tail
    `ci/validate-invoices.sh` is ours, so a vendored copy of the repo counts).

  ... and that same relative path is absent from the wheel image. (A path that
  IS in the image — e.g. a package module — is not checkout-only.)

WHEEL-RUNNABLE: everything else. Each such command must RESOLVE, one of:

  console-script   `einvoice ...`  -> the `[project.scripts]` target module
                                      (`einvoice/cli.py`) must exist in the image
  package-module   `python3 -m einvoice[.x]` -> `einvoice/__main__.py` /
                                      `einvoice/x.py` must exist in the image
  inline-python    `python3 -c '...'` -> every module it imports must be
                                      importable (stdlib) or present in the image
  stdlib-module    `python3 -m json.tool` -> resolvable via importlib (no import)
  bootstrap-tool   `python3 -m pip ...` -> the installer itself; not our package
  shell-utility    `cat`, `sed`, `sh`, `jq`, ... -> nothing of ours to resolve

HONEST LIMITS of this check:
  * It is static. "Resolves in the image" is not "produces the documented
    output" — that is `test_docs_example_output.py`'s job (checkout side) and a
    manual clean-venv run on the wheel side.
  * A path the reader supplies (`invoice.xml`, `invoices/`, `/path/to/einvoice`)
    cannot be validated from here; such commands are wheel-runnable as far as
    OUR artifacts go, which is all this test claims.
  * Fences tagged `sh`/`bash`/`console` must parse completely: an unrecognised
    program there is a hard FAIL, never a silent skip. In UNTAGGED ``` fences —
    which these docs use for both commands and sample output — a line counts as
    a command only if it starts with `$ ` or its program is one we know; other
    lines are read as output.

Scope note: `REPORT-FORMATS.md` and `EXIT-CODES.md` carry **no fenced blocks**
today — their CLI examples live as inline `code` spans inside prose and tables,
which this test deliberately does not parse (a `` `…` `` span is a reference,
not a copy-paste block). They are scanned anyway so that the day someone adds a
fence there, it is classified from the first commit.

Stdlib only, offline, a couple of seconds. The wheel image comes from
`test_wheel_self_report.build_install_image()` — imported, never re-implemented
— which copies exactly the `[tool.setuptools] packages` + `package-data`
declarations, no build backend and no network.

Plain python3: no pytest. Exits 1 on the first failed assertion (repo style).
"""

from __future__ import annotations

import importlib.util
import os
import re
import shlex
import shutil
import sys
import tempfile

from test_wheel_self_report import build_install_image

HERE = os.path.dirname(os.path.abspath(__file__))

DOCS = ("QUICKSTART.md", "README.md", "REPORT-FORMATS.md", "EXIT-CODES.md")

# The ONE annotation convention (see module docstring).
MARKER = "repository checkout"
MARKER_LOOKBACK = 12

# Fence info-strings whose bodies may contain shell commands. "" is the
# untagged fence, which these docs also use for sample output — see the
# per-line heuristic in ``iter_command_lines``.
SHELL_INFO = {"", "sh", "bash", "shell", "console"}

PYTHON_PROGRAMS = {"python", "python3"}

# Programs that are part of any reader's environment, not of our wheel. A
# command driven by one of these is wheel-runnable as long as it does not name
# a repository artifact.
SHELL_UTILITIES = {
    "sh", "bash", "cat", "sed", "grep", "head", "tail", "jq", "mkdir", "cd",
    "echo", "printf", "cp", "diff", "sort", "wc",
}

# `python3 -m <name>` targets that ship with the interpreter/installer rather
# than with our package. Checked by name, not by import: whether the reader's
# box has the installer is not a claim this repo makes.
BOOTSTRAP_MODULES = {"pip", "ensurepip", "venv"}

PATH_EXTS = (".py", ".xml", ".json", ".sh", ".toml", ".md", ".cfg", ".yaml",
             ".yml", ".txt", ".pdf")

# Tokens that are obviously placeholders in a synopsis, not real paths.
PLACEHOLDER_CHARS = set("<>[]{}*…")

REDIRECTS = {">", ">>", "<", "2>", "2>>", "&>"}
SPLITTERS = {"|", "||", "&&", ";", "|&"}

FENCE_RE = re.compile(r"```([^\n`]*)\n(.*?)```", re.DOTALL)
HEREDOC_RE = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
IMPORT_RE = re.compile(r"(?:^|;|\s)import\s+([A-Za-z_][\w.]*)")
FROM_RE = re.compile(r"(?:^|;|\s)from\s+([A-Za-z_][\w.]*)\s+import\b")


def fail(msg):
    print("FAIL:", msg)
    sys.exit(1)


# ---------------------------------------------------------------------------
# pyproject: the console scripts the wheel actually declares
# ---------------------------------------------------------------------------
def console_scripts():
    """``{script name: 'pkg.module'}`` from ``[project.scripts]``."""
    with open(os.path.join(HERE, "pyproject.toml"), encoding="utf-8") as fh:
        text = fh.read()
    section = re.search(r"(?ms)^\[project\.scripts\]\s*\n(.*?)(?=^\[|\Z)", text)
    if not section:
        fail("pyproject.toml declares no [project.scripts] table")
    out = {}
    for m in re.finditer(r"(?m)^\s*([A-Za-z0-9_.\-]+)\s*=\s*\"([^\"]+)\"",
                         section.group(1)):
        out[m.group(1)] = m.group(2).split(":", 1)[0]
    if not out:
        fail("could not parse any console script out of [project.scripts]")
    return out


# ---------------------------------------------------------------------------
# markdown: fences, headings, prose spans
# ---------------------------------------------------------------------------
class Fence(object):
    def __init__(self, info, body, start, end):
        self.info = info
        self.body = body
        self.start = start
        self.end = end


def parse_fences(text):
    return [Fence(m.group(1).strip(), m.group(2), m.start(), m.end())
            for m in FENCE_RE.finditer(text)]


def heading_stack(text, offset):
    """Enclosing headings above ``offset``, nearest first, one per level."""
    out = []
    level = 99
    for line in text[:offset].splitlines()[::-1]:
        m = HEADING_RE.match(line)
        if not m:
            continue
        lvl = len(m.group(1))
        if lvl < level:
            level = lvl
            out.append(m.group(2))
    return out


def prose_above(text, fences, idx):
    """The last MARKER_LOOKBACK non-blank lines between the previous fence and
    fence ``idx`` — the doc's own introduction of that block."""
    prev_end = fences[idx - 1].end if idx else 0
    lines = [l for l in text[prev_end:fences[idx].start].splitlines() if l.strip()]
    return "\n".join(lines[-MARKER_LOOKBACK:])


def normalise(text):
    """Lowercase, drop markdown emphasis/code markers, collapse whitespace — so
    the marker is found across a line wrap and inside ``**bold**``."""
    return re.sub(r"\s+", " ", re.sub(r"[*_`]", "", text)).lower()


def is_annotated(text, fences, idx):
    haystack = prose_above(text, fences, idx) + "\n" + \
        "\n".join(heading_stack(text, fences[idx].start))
    return MARKER in normalise(haystack)


# ---------------------------------------------------------------------------
# shell: pull command lines out of a fence body
# ---------------------------------------------------------------------------
def iter_command_lines(fence):
    """Yield ``(line, strict)`` for every candidate command in ``fence``.

    ``strict`` is True when the fence is explicitly tagged as shell (or the
    line is prompt-prefixed with ``$ ``): an unparsable/unknown program on such
    a line is a hard failure. Untagged fences also carry sample OUTPUT, so
    there a line is only a candidate when its first word is a program we know.

    Heredoc bodies (``cat > f <<'EOF'`` ... ``EOF``) are data, not commands,
    and are skipped.
    """
    tagged = fence.info != ""
    heredoc_end = None
    for raw in fence.body.splitlines():
        if heredoc_end is not None:
            if raw.strip() == heredoc_end:
                heredoc_end = None
            continue
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        prompted = line.startswith("$ ")
        if prompted:
            line = line[2:].strip()
        m = HEREDOC_RE.search(line)
        if m:
            heredoc_end = m.group(2)
        if tagged or prompted:
            yield line, True
        elif first_word(line) in known_programs():
            yield line, False


def first_word(line):
    word = line.split(None, 1)[0] if line.split() else ""
    while ASSIGN_RE.match(word):
        rest = line.split(None, 1)
        if len(rest) < 2:
            return ""
        line = rest[1]
        word = line.split(None, 1)[0]
    return word


_KNOWN = None


def known_programs():
    global _KNOWN
    if _KNOWN is None:
        _KNOWN = set(SHELL_UTILITIES) | set(PYTHON_PROGRAMS) | set(console_scripts())
    return _KNOWN


def split_pipeline(line, strict, where):
    """``line`` -> list of token lists, one per pipeline stage, redirections
    and leading VAR=VALUE assignments removed."""
    try:
        tokens = shlex.split(line, comments=True)
    except ValueError as exc:
        if strict:
            fail("%s: cannot tokenise documented command %r (%s)"
                 % (where, line, exc))
        return []
    stages = [[]]
    skip_next = False
    for tok in tokens:
        if skip_next:
            skip_next = False
            continue
        if tok in SPLITTERS:
            stages.append([])
            continue
        if tok in REDIRECTS:
            skip_next = True
            continue
        if HEREDOC_RE.fullmatch(tok):
            continue
        stages[-1].append(tok)
    out = []
    for stage in stages:
        while stage and ASSIGN_RE.match(stage[0]):
            stage = stage[1:]
        if stage:
            out.append(stage)
    return out


# ---------------------------------------------------------------------------
# repository artifacts vs the wheel image
# ---------------------------------------------------------------------------
def path_candidates(tokens):
    """Tokens that look like a filesystem path (placeholders excluded)."""
    out = []
    for tok in tokens:
        if tok.startswith("-"):
            continue
        if PLACEHOLDER_CHARS & set(tok):
            continue
        if "/" not in tok and not tok.endswith(PATH_EXTS):
            continue
        out.append(tok)
    return out


def repo_artifact(token):
    """Return the repo-relative path this token names, or None.

    Absolute paths are the reader's own. For a relative path we accept the
    token itself and any tail with >= 2 segments (so a vendored
    ``third_party/einvoice/ci/...`` still resolves to our ``ci/...``); a
    single-segment token is accepted only as an exact name in the repo root.
    """
    tok = token.strip()
    if tok.startswith("/") or tok.startswith("~") or tok.startswith("$"):
        return None
    while tok.startswith("./"):
        tok = tok[2:]
    tok = tok.rstrip("/")
    if not tok:
        return None
    parts = [p for p in tok.split("/") if p not in ("", ".")]
    if ".." in parts:
        return None
    for i in range(len(parts)):
        tail = parts[i:]
        if len(tail) < 2 and i > 0:
            break
        rel = "/".join(tail)
        if os.path.exists(os.path.join(HERE, *tail)):
            return rel
    return None


def in_image(image, rel):
    return os.path.exists(os.path.join(image, *rel.split("/")))


INSTALL_SUBCOMMANDS = {"install", "wheel", "download"}


def local_source_install(tokens):
    """Flag an installer command that builds from a LOCAL SOURCE TREE.

    An installer invocation whose target is ``.`` (or ``./third_party/…``)
    names no repository artifact by path — the target is a directory, not a
    file we can look up — yet it is exactly the "you must already have the
    sources" route a wheel-only reader does not have. Recognised structurally:
    the target is ``.``/``..`` or contains a ``/``, rather than being a
    package name resolved from an index.
    """
    parts = list(tokens)
    if parts[0] in PYTHON_PROGRAMS and len(parts) > 2 and parts[1] == "-m":
        parts = parts[2:]
    if not parts or parts[0] not in BOOTSTRAP_MODULES:
        return None
    rest = [t for t in parts[1:] if not t.startswith("-")]
    if not rest or rest[0] not in INSTALL_SUBCOMMANDS:
        return None
    for target in rest[1:]:
        if target in (".", "..") or "/" in target:
            return "a local source tree (%s)" % target
    return None


# ---------------------------------------------------------------------------
# resolution of a wheel-runnable command
# ---------------------------------------------------------------------------
def module_file(image, dotted):
    """Where ``dotted`` would live inside the install image."""
    parts = dotted.split(".")
    pkg_dir = os.path.join(image, *parts[:-1]) if len(parts) > 1 else None
    if len(parts) == 1:
        cand = [os.path.join(image, parts[0], "__init__.py"),
                os.path.join(image, parts[0] + ".py")]
    else:
        cand = [os.path.join(pkg_dir, parts[-1] + ".py"),
                os.path.join(pkg_dir, parts[-1], "__init__.py")]
    for c in cand:
        if os.path.exists(c):
            return c
    return None


def stdlib_resolvable(name):
    try:
        return importlib.util.find_spec(name.split(".")[0]) is not None
    except (ImportError, ValueError):
        return False


def resolve(tokens, image, scripts, where, line):
    """Return ``(kind, detail)`` for a wheel-runnable command, or fail."""
    prog = tokens[0]
    if prog in scripts:
        target = scripts[prog]
        path = module_file(image, target)
        if path is None:
            fail("%s: console script %r documented as wheel-runnable, but its "
                 "entry module %r is NOT in the wheel image (%r)"
                 % (where, prog, target, line))
        return "console-script", "%s -> %s" % (prog, target)

    if prog in PYTHON_PROGRAMS:
        args = tokens[1:]
        if args and args[0] == "-m":
            if len(args) < 2:
                fail("%s: `-m` with no module in %r" % (where, line))
            mod = args[1]
            root = mod.split(".")[0]
            if root == "einvoice":
                path = module_file(image, mod if "." in mod else "einvoice.__main__")
                if path is None:
                    fail("%s: `-m %s` documented as wheel-runnable, but %r is "
                         "NOT in the wheel image (%r)" % (where, mod, mod, line))
                return "package-module", "-m %s" % mod
            if root in BOOTSTRAP_MODULES:
                return "bootstrap-tool", "-m %s" % mod
            if stdlib_resolvable(mod):
                return "stdlib-module", "-m %s" % mod
            fail("%s: `-m %s` resolves neither in the wheel image nor as a "
                 "stdlib module (%r)" % (where, mod, line))
        if args and args[0] == "-c":
            if len(args) < 2:
                fail("%s: `-c` with no code in %r" % (where, line))
            code = args[1]
            mods = set(IMPORT_RE.findall(code)) | set(FROM_RE.findall(code))
            for mod in sorted(mods):
                for name in [m.strip() for m in mod.split(",")]:
                    if not name:
                        continue
                    if name.split(".")[0] == "einvoice":
                        if module_file(image, name) is None:
                            fail("%s: inline snippet imports %r, absent from "
                                 "the wheel image (%r)" % (where, name, line))
                    elif not stdlib_resolvable(name):
                        fail("%s: inline snippet imports %r, which is neither "
                             "stdlib nor in the wheel image (%r)"
                             % (where, name, line))
            return "inline-python", "-c (%d import(s))" % len(mods)
        scriptish = [a for a in args if not a.startswith("-")]
        if scriptish and scriptish[0].endswith(".py"):
            return "user-script", scriptish[0]
        fail("%s: cannot tell what %r runs — no -m, no -c, no script (%r)"
             % (where, prog, line))

    if prog in SHELL_UTILITIES:
        return "shell-utility", prog

    fail("%s: unrecognised program %r in documented command %r — classify it "
         "(add it to SHELL_UTILITIES or fix the doc), never skip it"
         % (where, prog, line))


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main():
    scripts = console_scripts()
    tmp = tempfile.mkdtemp(prefix="einvoice-doccmd-")
    try:
        image = build_install_image(tmp)
        if not os.path.exists(os.path.join(image, "einvoice", "cli.py")):
            fail("wheel image looks empty — einvoice/cli.py missing from %s" % image)
        # Sanity: the image must NOT carry the checkout-only trees, otherwise
        # every command would classify as wheel-runnable and prove nothing.
        for absent in ("examples", "corpus", "fixtures", "einvoice.py"):
            if os.path.exists(os.path.join(image, absent)):
                fail("wheel image unexpectedly contains %r — classification "
                     "would be meaningless" % absent)

        total = 0
        checkout_only = []
        wheel_runnable = []
        unannotated = []
        per_doc = {}

        for doc in DOCS:
            path = os.path.join(HERE, doc)
            if not os.path.isfile(path):
                fail("documented CLI doc is missing: %s" % doc)
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
            fences = parse_fences(text)
            per_doc[doc] = {"cmds": 0, "checkout": 0}

            for idx, fence in enumerate(fences):
                if fence.info not in SHELL_INFO:
                    continue
                annotated = None  # computed lazily, only when needed
                for line, strict in iter_command_lines(fence):
                    for tokens in split_pipeline(line, strict,
                                                 "%s fence @%d" % (doc, idx)):
                        where = "%s fence @%d" % (doc, idx)
                        total += 1
                        per_doc[doc]["cmds"] += 1
                        artifacts = []
                        for tok in path_candidates(tokens):
                            rel = repo_artifact(tok)
                            if rel is not None and not in_image(image, rel):
                                artifacts.append(rel)
                        local_src = local_source_install(tokens)
                        if local_src:
                            artifacts.append(local_src)
                        if artifacts:
                            per_doc[doc]["checkout"] += 1
                            checkout_only.append((doc, line, artifacts))
                            if annotated is None:
                                annotated = is_annotated(text, fences, idx)
                            if not annotated:
                                unannotated.append((doc, line, artifacts))
                        else:
                            kind, detail = resolve(tokens, image, scripts,
                                                   where, line)
                            wheel_runnable.append((doc, line, kind, detail))

        if unannotated:
            print("FAIL: %d documented command(s) cannot be run from a "
                  "`%s` install and are NOT labelled as needing the repo.\n"
                  "Add the marker %r to the prose right above the fence, or to "
                  "an enclosing heading:" % (len(unannotated),
                                             "verifyhash-einvoice", MARKER))
            for doc, line, artifacts in unannotated:
                print("  %-18s %s\n%s(needs: %s)"
                      % (doc, line, " " * 21, ", ".join(artifacts)))
            sys.exit(1)

        # Guards against a parser that silently finds nothing.
        if total < 15:
            fail("only %d command(s) extracted from %d docs — the fence parser "
                 "is not seeing the docs" % (total, len(DOCS)))
        if not checkout_only:
            fail("no checkout-only command found at all — the classifier is "
                 "not discriminating (examples/ is not in the wheel)")

        # The point of the task: QUICKSTART must give a wheel-only reader a
        # real path — at least one console-script command that touches no
        # repository artifact.
        qs_console = [c for c in wheel_runnable
                      if c[0] == "QUICKSTART.md" and c[2] == "console-script"]
        if not qs_console:
            fail("QUICKSTART.md has no wheel-runnable `einvoice ...` command — "
                 "a reader who installed the package has nothing to run")

        print("ok: %d fenced command(s) across %d docs" % (total, len(DOCS)))
        for doc in DOCS:
            print("    %-18s %3d command(s), %d checkout-only"
                  % (doc, per_doc[doc]["cmds"], per_doc[doc]["checkout"]))
        print("    wheel-runnable: %d   checkout-only (all annotated): %d"
              % (len(wheel_runnable), len(checkout_only)))
        kinds = {}
        for _, _, kind, _ in wheel_runnable:
            kinds[kind] = kinds.get(kind, 0) + 1
        for kind in sorted(kinds):
            print("      %-16s %d" % (kind, kinds[kind]))
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())

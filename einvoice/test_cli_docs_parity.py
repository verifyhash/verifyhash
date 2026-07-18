#!/usr/bin/env python3
"""test_cli_docs_parity.py — CLI ↔ docs command/flag/exit-code parity guard
(T-VHDOCV.1).

MEASURE-FIRST result (why this file is new, not a duplicate). The adjacent
CLI/doc guards each pin a *slice*, and none pins the full three-legged
command/flag/exit-code surface against what the docs advertise:

  * test_cli.py            — ergonomics (--version/--quiet/--json/stdin) in
                             isolation; it never cross-checks the doc files.
  * test_exit_codes.py     — drives exit codes 0/1/2/3 (and pins the 130/143
                             *constants*), but does NOT enumerate every CLI
                             flag/subcommand nor assert each is documented, and
                             does not check for phantom (doc-only) flags.
  * test_stranger_journey.py — walks the documented QUICKSTART/report path and
                             checks EXIT-CODES.md constants equal the CLI
                             constants; it does not assert that *every* accepted
                             subcommand + flag (e.g. `receipt --verify`,
                             `--show-config`, `--fail-on`, `info`) appears in a
                             doc, nor that every doc-advertised runnable token is
                             actually accepted by the parser.
  * test_install_command_drift.py — pins the `pip install` package name and
                             German command byte-parity only.

So the specific gap this closes: there was NO test asserting the CLI's real
command/flag surface (as parsed from `einvoice/cli.py`'s USAGE constant and its
dispatch string literals) matches what README.md / QUICKSTART.md / EXIT-CODES.md
/ RECEIPT-VERIFICATION.md advertise — including the newly landed
`receipt --verify` (EPIC-VHRVFY) and the receipt/schema docs (EPIC-VHSCHEMA2).

The surface is DERIVED from the real module, never hand-listed:
  * accepted flags come from parsing `einvoice.cli.USAGE` AND are cross-checked
    against the flag string literals in the dispatch source, so a stale USAGE
    or a new dispatch branch is caught;
  * accepted subcommands come from parsing `einvoice.cli.USAGE`;
  * returnable exit codes come from the `EXIT_*` constants the source actually
    `return`s.

Three legs, exactly as the task specifies:
  (a) every accepted subcommand + flag (incl. `receipt --verify`) is documented
      in at least one of the four doc files;
  (b) every flag/subcommand token the docs advertise as a *runnable* einvoice
      command (extracted from fenced code blocks, excluding the separate
      `python3 -m einvoice.report` entry point) is actually accepted by the CLI
      — driven through `main()`, asserting it is not rejected as an unknown
      positional / usage error;
  (c) every exit code enumerated in EXIT-CODES.md is one the CLI source can
      actually return, and the ordinary 0/1/2/3 codes are driven live.

Fast, stdlib-only, offline. Adds no product behaviour and changes no validation.
Run: python3 test_cli_docs_parity.py
"""

import io
import os
import re
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import einvoice.cli as cli  # noqa: E402
from einvoice.cli import (  # noqa: E402
    main,
    EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE,
    EXIT_PIPE, EXIT_INT, EXIT_TERM,
)

# The four user-facing docs that make up the CLI's documented surface.
DOC_FILES = ("README.md", "QUICKSTART.md", "EXIT-CODES.md",
             "RECEIPT-VERIFICATION.md")

# Committed fixtures reused verbatim from test_cli.py / test_exit_codes.py — no
# new corpus data is introduced here.
PASS_FIXTURE = os.path.join(HERE, "corpus", "vendored", "valid",
                            "cen-bis3-positive_ubl.xml")
FAIL_FIXTURE = os.path.join(HERE, "fixtures",
                            "creditnote-invalid-typecode_ubl.xml")
MALFORMED_XML = b"<Invoice><never-closed>"

# The valued flags of THIS CLI (they consume the next argv token when given in
# space form). Derived below from the dispatch source too; listed here only to
# drive the recognized-ness probe, and asserted equal to the source in
# test_valued_flags_match_source.
_VALUED_FLAGS = ("--profile", "--lang", "--fail-on")


# --------------------------------------------------------------------------- #
# In-process driver (identical shape to test_cli._Capture).
# --------------------------------------------------------------------------- #
class _Capture:
    def __init__(self, argv):
        self.argv = argv
        self.rc = None
        self.out = ""
        self.err = ""

    def __enter__(self):
        self._out, self._err = sys.stdout, sys.stderr
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
        self.rc = main(self.argv)
        self.out = sys.stdout.getvalue()
        self.err = sys.stderr.getvalue()
        return self

    def __exit__(self, *exc):
        sys.stdout, sys.stderr = self._out, self._err
        return False


def drive(argv):
    """Drive the real CLI entry point on ``argv``; return (rc, stdout, stderr)."""
    with _Capture(argv) as cap:
        return cap.rc, cap.out, cap.err


# --------------------------------------------------------------------------- #
# Surface derivation — parse the REAL cli.py, never a hand-kept parallel list.
# --------------------------------------------------------------------------- #
def _norm_token(tok):
    """Strip shell/markdown wrappers ([], <>, quotes, backticks) from a token."""
    return tok.strip("[](){}<>`\"'")


def usage_surface():
    """Parse ``einvoice.cli.USAGE`` into (subcommands, flags).

    Each USAGE line has the shape ``einvoice <sub-or-global-flag> ...``: the
    token right after ``einvoice`` is a subcommand when it is a bare word, or a
    global flag when it starts with ``--``; every ``--`` token on the line is a
    flag (``=value`` suffix and surrounding brackets stripped).
    """
    subs, flags = set(), set()
    for line in cli.USAGE.splitlines():
        toks = line.split()
        if "einvoice" not in toks:
            continue
        idx = toks.index("einvoice")
        # Token immediately after the program name.
        if idx + 1 < len(toks):
            head = _norm_token(toks[idx + 1])
            if head and not head.startswith("--") and re.match(
                    r"^[a-z][a-z-]*$", head):
                subs.add(head)
        for tok in toks:
            n = _norm_token(tok)
            if n.startswith("--"):
                flags.add(n.split("=", 1)[0])
    return subs, flags


def dispatch_flags_from_source():
    """Every ``--flag`` string LITERAL in the cli.py dispatch source.

    Matches only a ``--`` that immediately follows an opening double quote — i.e.
    a genuine parser literal like ``"--profile"`` / ``"--fail-on="`` — so RST
    docstring text (```` ``--json`` ````) and the bracketed USAGE placeholders
    (``[--json]``) are not counted.
    """
    src = _cli_source()
    return {m for m in re.findall(r'"(--[a-z][a-z-]+)', src)}


def _cli_source():
    with open(cli.__file__, encoding="utf-8") as fh:
        return fh.read()


def returnable_exit_codes():
    """The set of exit-code VALUES the cli.py source actually ``return``s,
    resolved from the ``EXIT_*`` constant names to their imported values."""
    src = _cli_source()
    names = set(re.findall(r"return\s+(EXIT_[A-Z]+)", src))
    const = {
        "EXIT_OK": EXIT_OK, "EXIT_FAIL": EXIT_FAIL, "EXIT_USAGE": EXIT_USAGE,
        "EXIT_PARSE": EXIT_PARSE, "EXIT_PIPE": EXIT_PIPE, "EXIT_INT": EXIT_INT,
        "EXIT_TERM": EXIT_TERM,
    }
    return {const[n] for n in names if n in const}


# --------------------------------------------------------------------------- #
# Doc parsing.
# --------------------------------------------------------------------------- #
def doc_text(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as fh:
        return fh.read()


def combined_docs():
    return "\n".join(doc_text(n) for n in DOC_FILES)


def fenced_lines(text):
    """Content lines inside ``` fenced code blocks (fence markers dropped)."""
    out, in_fence = [], False
    for raw in text.splitlines():
        if raw.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            out.append(raw)
    return out


# Entry points for the einvoice CLI proper, ANCHORED at the start of a
# (prompt-stripped) command line. Anchoring excludes a Python ``from einvoice
# import ...`` embed line and any mid-line mention. Deliberately excludes
# ``python3 -m einvoice.report`` (a SEPARATE entry point with its own flags such
# as --format/--pretty/--recurse): after ``einvoice`` must come whitespace, so
# ``einvoice.report`` / ``einvoice.py`` never match the module/console forms.
_ENTRY_RE = re.compile(
    r"(?:python3\s+-m\s+einvoice(?=\s)"
    r"|python3\s+einvoice\.py(?=\s)"
    r"|einvoice(?=\s))")
_PROMPT_RE = re.compile(r"^\s*\$\s*")

_SHELL_SEP = ("#", "|", ";", ">", "&&", "&")


def advertised_surface():
    """(subcommands, flags) the docs advertise as RUNNABLE einvoice commands.

    Only fenced code blocks are considered (a runnable command is a full command
    line, not an inline mention). For each line that invokes the einvoice CLI
    (not ``einvoice.report``), the argument tail is tokenised: the first bare
    word is the subcommand, every ``--`` token is a flag; the value of a
    space-form valued flag (``--profile xrechnung``) is skipped so it is not
    misread as a subcommand.
    """
    subs, flags = set(), set()
    for name in DOC_FILES:
        for line in fenced_lines(doc_text(name)):
            stripped = _PROMPT_RE.sub("", line)
            m = _ENTRY_RE.match(stripped)
            if not m:
                continue
            tail = stripped[m.end():]
            for sep in _SHELL_SEP:
                tail = tail.split(sep, 1)[0]
            prev_valued = False
            sub_found = False
            for tok in tail.split():
                n = _norm_token(tok)
                if not n:
                    continue
                if n.startswith("--"):
                    flag = n.split("=", 1)[0]
                    flags.add(flag)
                    prev_valued = (flag in _VALUED_FLAGS and "=" not in n)
                    continue
                if prev_valued:
                    prev_valued = False
                    continue
                prev_valued = False
                if not sub_found and re.match(r"^[a-z][a-z-]*$", n):
                    subs.add(n)
                    sub_found = True
    return subs, flags


# --------------------------------------------------------------------------- #
# Recognized-ness probes (leg b) — drive the real parser.
# --------------------------------------------------------------------------- #
def flag_is_recognized(flag):
    """True iff the CLI parser RECOGNIZES ``flag`` (consumes it) rather than
    leaving it as an unknown positional.

    Probe harness: ``einvoice info <flag>``. ``info`` accepts only global flags
    (all stripped before dispatch) and rejects ANY leftover positional with
    ``error: info takes no arguments``. So:
      * a recognized boolean/global flag is stripped -> ``info`` runs -> exit 0;
      * a recognized valued flag given bare (``--profile``) hits its own
        ``error: --profile needs a value`` -> also proves recognition;
      * a phantom flag survives into ``info`` -> ``takes no arguments`` -> NOT
        recognized.
    """
    rc, _out, err = drive(["info", flag])
    if "takes no arguments" in err:
        return False
    return rc == EXIT_OK or "needs a value" in err


def subcommand_is_accepted(sub):
    """True iff ``sub`` is a real subcommand the dispatcher branches on.

    Probe: ``einvoice <sub> <pass-fixture>``. A real subcommand either runs
    (exit 0: validate / validate-batch / receipt on a passing invoice) or emits
    its OWN actionable ``error:`` line (``info`` rejects the extra arg). An
    unknown subcommand falls through to the top-level dispatch, which writes only
    the bare ``usage:`` banner (no ``error:`` line) and exits 2.
    """
    rc, _out, err = drive([sub, PASS_FIXTURE])
    return rc == EXIT_OK or "error:" in err


# --------------------------------------------------------------------------- #
# Preconditions.
# --------------------------------------------------------------------------- #
class Fixtures(unittest.TestCase):
    def test_fixtures_and_docs_present(self):
        self.assertTrue(os.path.isfile(PASS_FIXTURE), PASS_FIXTURE)
        self.assertTrue(os.path.isfile(FAIL_FIXTURE), FAIL_FIXTURE)
        for name in DOC_FILES:
            self.assertTrue(os.path.isfile(os.path.join(HERE, name)), name)


class SurfaceDerivation(unittest.TestCase):
    """The derived surface is non-empty and comes from the real module."""

    def test_usage_surface_nonempty(self):
        subs, flags = usage_surface()
        # The four documented subcommands and the global flags must all be
        # discoverable from USAGE (sanity that the parse is not vacuous).
        self.assertEqual(subs, {"validate", "validate-batch", "receipt", "info"},
                         "USAGE subcommand parse drifted: %r" % subs)
        for f in ("--json", "--quiet", "--profile", "--lang", "--fail-on",
                  "--verify", "--show-config", "--version"):
            self.assertIn(f, flags, "USAGE is missing flag %s" % f)

    def test_usage_flags_match_dispatch_source(self):
        # The authoritative surface is USAGE AND the dispatch logic; pin them
        # together so a new dispatch branch or a stale USAGE line is caught.
        _subs, usage_flags = usage_surface()
        self.assertEqual(
            usage_flags, dispatch_flags_from_source(),
            "cli.USAGE flags disagree with the parser's dispatch string "
            "literals (one of them drifted)")

    def test_valued_flags_match_source(self):
        # The space-form valued flags used by the leg-(b) probe are exactly the
        # ones the source parses with a following value token.
        src = _cli_source()
        parsed_valued = set()
        for f in ("--profile", "--lang", "--fail-on"):
            if ('a == "%s"' % f) in src and ('"%s="' % f) in src:
                parsed_valued.add(f)
        self.assertEqual(parsed_valued, set(_VALUED_FLAGS),
                         "valued-flag set drifted from cli.py: %r" % parsed_valued)


# --------------------------------------------------------------------------- #
# Leg (a): every accepted subcommand + flag is documented somewhere.
# --------------------------------------------------------------------------- #
class LegADocumented(unittest.TestCase):
    def test_every_accepted_flag_is_documented(self):
        docs = combined_docs()
        _subs, flags = usage_surface()
        self.assertTrue(flags)
        for flag in sorted(flags):
            self.assertIn(
                flag, docs,
                "accepted CLI flag %s is not documented in any of %s"
                % (flag, ", ".join(DOC_FILES)))

    def test_every_accepted_subcommand_is_documented(self):
        docs = combined_docs()
        subs, _flags = usage_surface()
        self.assertTrue(subs)
        for sub in sorted(subs):
            self.assertRegex(
                docs, r"\b%s\b" % re.escape(sub),
                "accepted subcommand %r is not documented" % sub)

    def test_receipt_verify_pair_is_documented(self):
        # The newly landed compound command must be documented as such (not just
        # `receipt` and `--verify` separately).
        docs = combined_docs()
        self.assertIn(
            "receipt --verify", docs,
            "the `receipt --verify` command is not documented in any doc file")
        # And it must be a real accepted combination: receipt + --verify.
        subs, flags = usage_surface()
        self.assertIn("receipt", subs)
        self.assertIn("--verify", flags)


# --------------------------------------------------------------------------- #
# Leg (b): every doc-advertised runnable token is accepted (no phantom).
# --------------------------------------------------------------------------- #
class LegBNoPhantom(unittest.TestCase):
    def test_advertised_flags_are_accepted(self):
        subs, flags = advertised_surface()
        self.assertTrue(flags, "no runnable einvoice flags found in fenced docs")
        _usub, real_flags = usage_surface()
        for flag in sorted(flags):
            with self.subTest(flag=flag):
                # Driven through the real parser (not just set membership).
                self.assertTrue(
                    flag_is_recognized(flag),
                    "doc-advertised flag %s is a PHANTOM — the CLI rejects it "
                    "as unknown" % flag)
                # And it is genuinely part of the parser's surface.
                self.assertIn(
                    flag, real_flags,
                    "doc-advertised flag %s is not in the CLI's accepted flag "
                    "surface" % flag)

    def test_advertised_subcommands_are_accepted(self):
        subs, _flags = advertised_surface()
        self.assertTrue(subs, "no runnable einvoice subcommands in fenced docs")
        real_subs, _rf = usage_surface()
        for sub in sorted(subs):
            with self.subTest(sub=sub):
                self.assertTrue(
                    subcommand_is_accepted(sub),
                    "doc-advertised subcommand %r is a PHANTOM — the CLI does "
                    "not accept it" % sub)
                self.assertIn(
                    sub, real_subs,
                    "doc-advertised subcommand %r is not in the CLI surface"
                    % sub)

    def test_a_fake_flag_is_detected_as_phantom(self):
        # Non-vacuity: the phantom detector genuinely rejects an unknown flag,
        # so a green run of the two tests above means something.
        self.assertFalse(flag_is_recognized("--definitely-not-a-flag"))

    def test_a_fake_subcommand_is_detected_as_phantom(self):
        self.assertFalse(subcommand_is_accepted("frobnicate"))


# --------------------------------------------------------------------------- #
# Leg (c): every exit code in EXIT-CODES.md is reachable by a tested path.
# --------------------------------------------------------------------------- #
def documented_exit_codes():
    """Integers from the main EXIT-CODES.md code table (rows ``| `N` | ...``)."""
    text = doc_text("EXIT-CODES.md")
    return {int(n) for n in re.findall(r"^\|\s*`(\d+)`\s*\|", text, re.M)}


class LegCExitCodes(unittest.TestCase):
    def test_documented_codes_are_returnable_by_the_cli(self):
        doc_codes = documented_exit_codes()
        # The table documents at minimum the full 0/1/2/3 + signal/pipe family.
        self.assertTrue({0, 1, 2, 3, 141, 130, 143} <= doc_codes,
                        "EXIT-CODES.md table lost a documented code: %r"
                        % doc_codes)
        reachable = returnable_exit_codes()
        for code in sorted(doc_codes):
            self.assertIn(
                code, reachable,
                "EXIT-CODES.md documents exit code %d but nothing in cli.py "
                "returns it" % code)

    def test_ordinary_codes_are_driven_live(self):
        # 0 / 1 / 2 / 3 are cheap to reach in-process — prove each concretely.
        rc0, _o, _e = drive(["validate", PASS_FIXTURE])
        self.assertEqual(rc0, EXIT_OK)

        rc1, _o, _e = drive(["validate", FAIL_FIXTURE])
        self.assertEqual(rc1, EXIT_FAIL)

        rc2, _o, err2 = drive(["validate", "does-not-exist.xml"])
        self.assertEqual(rc2, EXIT_USAGE)
        self.assertIn("error:", err2)

        fd, tmp = tempfile.mkstemp(suffix=".xml")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(MALFORMED_XML)
            rc3, _o, _e = drive(["validate", tmp])
            self.assertEqual(rc3, EXIT_PARSE)
        finally:
            os.unlink(tmp)

    def test_signal_and_pipe_codes_are_distinct_constants(self):
        # 141/130/143 are exercised end-to-end by test_pipe_discipline.py /
        # test_interrupt.py; here confirm they are the returnable constants the
        # doc rows enumerate, distinct from the ordinary codes.
        self.assertEqual((EXIT_PIPE, EXIT_INT, EXIT_TERM), (141, 130, 143))
        self.assertEqual(len({EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE,
                              EXIT_PIPE, EXIT_INT, EXIT_TERM}), 7)


if __name__ == "__main__":
    unittest.main(verbosity=2)

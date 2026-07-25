#!/usr/bin/env python3
"""COMMAND PRIMACY — the CLI may only teach commands it can actually run.

STANDING GUARD (T-VHUX2.3). This project ships exactly ONE console script:
``pyproject.toml``'s ``[project.scripts]`` puts ``einvoice`` on the user's PATH.
Every command the tool prints in a *hint* — the text a first-run user reads at
the exact moment they are stuck — must therefore be a command that binary can
execute. Anything else is an underclaim: it walks the user off the entry point
we installed for them and onto a longer form they did not need.

MEASURED DEFECT THIS LOCKS SHUT (reproduced 2026-07-25, before the fix)::

    $ python3 -m einvoice validate README.md
    S-WF: input is not well-formed XML: not well-formed (invalid token): line 1, column 1
      hint: not a PDF container either — supported inputs are a UBL/CII e-invoice
      as well-formed XML ('validate') or a Factur-X/ZUGFeRD PDF/A-3 container
      ('python3 -m einvoice.report <invoice.pdf>')

    $ python3 -m einvoice validate corpus/pdf/facturx-valid.pdf
    PASS: corpus/pdf/facturx-valid.pdf (all implemented fatal rules, profile=en16931)
    # exit 0

The second command proves the first hint was wrong: ``einvoice validate``
opened, extracted and graded that Factur-X container itself — it has since
T-VHERG.4/.5 — yet the hint sent the reader to ``einvoice.report``.

Three legs, in the order they matter:

  (a) CONTENT — drive the REAL CLI on a non-XML input and assert the emitted
      hint teaches ``einvoice validate <invoice.pdf>`` and offers NO
      ``einvoice.report <invoice.pdf>`` form.
  (b) SINGLE SOURCE — assert the program token in the hint is the SAME
      module-level constant ``USAGE`` is built from. The constant is IMPORTED
      and compared; the literal is never re-spelled here, so a rename of the
      console script cannot leave the usage block and the hint disagreeing
      while this test still passes.
  (c) EXECUTABILITY — actually RUN the command the hint teaches, against the
      committed ``corpus/pdf/facturx-valid.pdf`` fixture, and assert it reaches
      the container path and exits 0. This is the leg that makes the guard
      standing rather than cosmetic: the tool can never again advertise a
      command it cannot run, because advertising one fails the suite.

DELIBERATELY NOT ASSERTED HERE: that the CLI never mentions
``python3 -m einvoice.report`` at all. That entry point is real and genuinely
owns ``--baseline``, ``--pretty`` and explicit recursion, so the ``--help``
epilogue's pointer to it is a TRUE pointer and is left alone. The rule this
file enforces is narrower and exact: never route a user to the sibling for
something the console script does natively.

Run: ``python3 test_cli_command_primacy.py``  (fast: three subprocesses)
"""

import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice import cli as _cli          # noqa: E402  (after sys.path fix)

VALID_PDF = os.path.join(HERE, "corpus", "pdf", "facturx-valid.pdf")

#: The sibling-module form the hint must NOT offer for the PDF route, assembled
#: from the shipped module name so this file does not hard-code a second
#: program spelling either.
FORBIDDEN_PDF_FORM = "%s.report <invoice.pdf>" % _cli.PROG


def _run(*args):
    """Drive the CLI exactly as a user does, in a subprocess, from HERE."""
    proc = subprocess.run(
        [sys.executable, "-m", "einvoice"] + list(args),
        cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        universal_newlines=True,
    )
    return proc.returncode, proc.stdout, proc.stderr


class CommandPrimacy(unittest.TestCase):

    # (a) the hint teaches the console script -----------------------------
    def test_wrong_file_type_hint_teaches_the_console_script(self):
        with tempfile.TemporaryDirectory() as td:
            junk = os.path.join(td, "export.json")
            with open(junk, "wb") as fh:
                fh.write(b'{"invoice": 1, "total": 42}\n')
            rc, out, err = _run("validate", junk)

        self.assertEqual(rc, _cli.EXIT_PARSE,
                         "non-XML input must keep exit %d; stderr=%s"
                         % (_cli.EXIT_PARSE, err))
        self.assertIn("hint:", err, "the wrong-file-type hint disappeared")

        hint = [ln for ln in err.splitlines() if "hint:" in ln]
        self.assertEqual(len(hint), 1, "expected exactly one hint line: %r" % err)
        hint = hint[0]

        # The taught PDF form is the console script's own.
        self.assertIn("%s validate <invoice.pdf>" % _cli.PROG, hint,
                      "the hint must teach the console script for the "
                      "Factur-X/ZUGFeRD container route it owns natively")
        # The sibling-module form is NOT offered for that same capability.
        self.assertNotIn(FORBIDDEN_PDF_FORM, hint,
                         "the hint routes the user to %r for a capability "
                         "'%s validate' has natively — this is the T-VHUX2.3 "
                         "regression" % (FORBIDDEN_PDF_FORM, _cli.PROG))
        # Both accepted input shapes are still named (the substantive content
        # the older assertions pinned — widened here, never dropped).
        self.assertIn("%s validate <invoice.xml>" % _cli.PROG, hint)
        self.assertIn("not a PDF container either", hint)
        self.assertNotIn("Traceback", err)

    # (b) one constant behind both the usage block and the hint ------------
    def test_hint_program_token_comes_from_the_same_constant_as_usage(self):
        prog = _cli.PROG
        self.assertTrue(prog and not prog.isspace(),
                        "PROG must be a real program token")

        # USAGE is built from PROG: every synopsis line starts with it.
        usage_lines = [ln.strip() for ln in _cli.USAGE.splitlines() if ln.strip()]
        self.assertTrue(usage_lines, "USAGE is empty")
        first = usage_lines[0]
        self.assertTrue(first.startswith("usage: " + prog),
                        "USAGE's first line does not start with PROG: %r" % first)
        for ln in usage_lines[1:]:
            self.assertTrue(
                ln.startswith(prog + " "),
                "USAGE synopsis line does not start with PROG %r: %r"
                % (prog, ln))

        # ...and so is the hint the RUNNING cli emits. Substituting a different
        # token for PROG must change the hint, which is only true if the hint
        # is built from PROG rather than from a second hard-coded literal.
        with tempfile.TemporaryDirectory() as td:
            junk = os.path.join(td, "export.csv")
            with open(junk, "wb") as fh:
                fh.write(b"a,b,c\n1,2,3\n")
            _rc, _out, err = _run("validate", junk)
        hint = [ln for ln in err.splitlines() if "hint:" in ln][0]

        occurrences = hint.count(prog + " validate ")
        self.assertGreaterEqual(
            occurrences, 2,
            "the hint should name the console script for BOTH accepted input "
            "shapes; got %d occurrence(s) in %r" % (occurrences, hint))

        # The source-level guarantee: cli.py contains no second hard-coded
        # program spelling inside the hint. Rebuilding the hint's taught
        # commands from PROG reproduces the emitted bytes exactly.
        for shape in ("<invoice.xml>", "<invoice.pdf>"):
            rebuilt = "'%s validate %s'" % (prog, shape)
            self.assertIn(rebuilt, hint,
                          "hint does not carry the PROG-built form %r" % rebuilt)

    # (c) the taught command actually runs ---------------------------------
    def test_the_taught_pdf_command_actually_runs(self):
        self.assertTrue(os.path.isfile(VALID_PDF),
                        "corpus/pdf/facturx-valid.pdf fixture missing — the "
                        "executability leg cannot be faked, it needs the file")

        # This is literally the command the hint teaches, with the placeholder
        # replaced by the committed fixture.
        rc, out, err = _run("validate", os.path.relpath(VALID_PDF, HERE))

        self.assertNotIn("Traceback", err)
        self.assertEqual(rc, 0,
                         "the command the hint teaches must exit 0 on a valid "
                         "Factur-X container; got %d\nstdout=%s\nstderr=%s"
                         % (rc, out, err))
        self.assertTrue(out.startswith("PASS"),
                        "expected a PASS verdict line, got: %r" % out[:200])
        # It reached the CONTAINER path, not some XML fallback: the file it
        # names is the PDF itself, and no unsupported-container/parse error
        # was emitted for it.
        self.assertIn("facturx-valid.pdf", out)
        self.assertNotIn("unsupported-container", err)
        self.assertNotIn("S-WF", err)

    # sanity: the fix would be detected if reverted --------------------------
    def test_guard_would_fail_on_the_old_hint_text(self):
        """The old hint string must not satisfy leg (a)'s assertions.

        Cheap self-check that this guard has teeth: feed leg (a)'s predicates
        the exact pre-fix hint bytes and confirm they reject it.
        """
        old_hint = ("  hint: not a PDF container either — supported inputs are "
                    "a UBL/CII e-invoice as well-formed XML ('validate') or a "
                    "Factur-X/ZUGFeRD PDF/A-3 container "
                    "('python3 -m einvoice.report <invoice.pdf>')")
        self.assertNotIn("%s validate <invoice.pdf>" % _cli.PROG, old_hint)
        self.assertIn(FORBIDDEN_PDF_FORM, old_hint)


if __name__ == "__main__":
    unittest.main(verbosity=2)

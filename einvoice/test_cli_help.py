"""Completeness guard for ``einvoice --help`` / ``-h``.

The point of this test is NOT to pin the exact wording of the help text — it is
to bind the help output to the real command registries so a command can never be
added to the CLI and silently go undocumented. It imports ``COMMAND_SURFACE``,
``VALID_SUBCOMMANDS`` and ``OUTPUT_FORMATS`` straight from :mod:`einvoice.cli`
(and ``capabilities()['formats']`` from the package) and asserts that every
registry entry is named in the help. If someone adds a command to
``COMMAND_SURFACE`` but forgets to describe it in ``HELP``, this test fails.

SELF-NAVIGABILITY LEGS (T-VHWHEEL.4 / T-VHSTR.4). The installed wheel is the
only artifact a PyPI stranger ever touches, and three measured drop-offs were
fixed together; each has a guard here so it cannot rot back:

  (a) BANNER/HELP PARITY — the ``unknown subcommand`` error's choice list used
      to be formatted from ``VALID_SUBCOMMANDS`` (the DISPATCH tuple), so a
      mistyped command was told to "choose from validate, validate-batch,
      receipt" while ``--help`` documented ``info`` and ``--show-config`` as
      well. Both now read ``COMMAND_SURFACE``, and the guard below reads the
      same tuple rather than a duplicated literal.
  (b) FORMAT COVERAGE — every name in ``einvoice.capabilities()['formats']``
      must appear in the help text, so registering a tenth emitter in
      ``einvoice.report.REPORT_FORMATS`` without documenting it FAILS here
      instead of shipping invisible.
  (c) RESOLVABLE POINTERS — no runtime help/usage string (this CLI's or
      ``einvoice.report``'s) may name a ``*.md`` file. Those files live in the
      git repo and are NOT in the wheel, so a pip-only user was being sent to a
      path that does not exist on their disk; the fix is a URL.

Runnable standalone: ``python3 test_cli_help.py`` (also collected by unittest).
"""

import io
import os
import re
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import einvoice  # noqa: E402
from einvoice.cli import (  # noqa: E402
    main, VALID_SUBCOMMANDS, COMMAND_SURFACE, OUTPUT_FORMATS,
    DELEGATED_FORMATS, USAGE, HELP, EXIT_OK, EXIT_USAGE)
from einvoice.report import (  # noqa: E402
    main as report_main, USAGE as REPORT_USAGE,
    REPORT_FORMATS, BATCH_FORMATS)

#: Doc files that live in the git checkout but are NOT packaged in the wheel.
#: A runtime message may not send a pip-only user to any of them. Matched
#: generically (any ``*.md`` token) so a NEW markdown pointer is caught too.
_MD_TOKEN = re.compile(r"\b[\w.-]+\.md\b", re.IGNORECASE)


def _run(argv):
    """Invoke the CLI with ``argv``; return (exit_code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = main(argv)
    return code, out.getvalue(), err.getvalue()


def _run_report(argv):
    """Invoke ``python3 -m einvoice.report`` in-process with ``argv``;
    return (exit_code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = report_main(argv)
    return code, out.getvalue(), err.getvalue()


class HelpFlagTest(unittest.TestCase):
    def test_help_exits_ok_and_writes_stdout(self):
        code, out, err = _run(["--help"])
        self.assertEqual(code, EXIT_OK, "--help must exit 0 (EXIT_OK)")
        self.assertTrue(out.strip(), "--help must write help text to stdout")
        self.assertNotIn(
            "unknown subcommand", (out + err),
            "--help must not hit the unknown-subcommand error path")

    def test_help_goes_to_stdout_not_stderr(self):
        _, out, err = _run(["--help"])
        self.assertIn("usage: einvoice", out)
        self.assertEqual(err, "", "--help must not write to stderr")

    def test_help_documents_every_valid_subcommand(self):
        # The completeness guard: sourced from the real registry, not a literal.
        _, out, _ = _run(["--help"])
        for sub in VALID_SUBCOMMANDS:
            self.assertIn(
                sub, out,
                "help output is missing VALID_SUBCOMMANDS entry %r "
                "(a subcommand went undocumented)" % sub)

    def test_help_documents_every_command_in_the_shared_surface(self):
        # Read from COMMAND_SURFACE — the SAME tuple the unknown-subcommand
        # banner formats its choice list from — never from a literal here.
        _, out, _ = _run(["--help"])
        for name in COMMAND_SURFACE:
            self.assertIn(
                name, out,
                "help output is missing COMMAND_SURFACE entry %r "
                "(a documented command went undocumented in HELP)" % name)

    def test_command_surface_is_dispatch_plus_the_informational_commands(self):
        # COMMAND_SURFACE is the documentation set; it must be a strict
        # SUPERSET of the dispatch set, so relabelling one can never quietly
        # drop a real subcommand out of the banner.
        for sub in VALID_SUBCOMMANDS:
            self.assertIn(sub, COMMAND_SURFACE,
                          "dispatch subcommand %r missing from the documented "
                          "surface" % sub)
        for name in ("info", "--show-config", "--version", "--help"):
            self.assertIn(name, COMMAND_SURFACE,
                          "informational command %r missing from the "
                          "documented surface" % name)

    def test_error_banner_and_help_advertise_the_same_command_set(self):
        # The parity leg: whatever the banner offers as choices must be exactly
        # what --help documents. Both sides are read from the live outputs, and
        # the expected set comes from COMMAND_SURFACE (one shared definition).
        _, help_out, _ = _run(["--help"])
        # The probe token must be one the CLI genuinely does NOT accept. It used
        # to be ``--explain``; T-VHERG.3 routed that flag to the real catalog
        # lookup, so ``explain`` (the dash-less near-miss a user actually types)
        # is the mistyped stand-in now — same banner path, still a real typo.
        code, _, err = _run(["explain", "BR-DE-1"])
        self.assertEqual(code, 2, "a mistyped subcommand must still exit 2")
        banner = [ln for ln in err.splitlines() if "unknown subcommand" in ln]
        self.assertEqual(len(banner), 1,
                         "the banner must stay ONE line, got %r" % (banner,))
        choices = banner[0].split("choose from", 1)[1].rstrip(")").strip()
        self.assertEqual(
            [c.strip() for c in choices.split(",")], list(COMMAND_SURFACE),
            "the banner's choice list must be COMMAND_SURFACE verbatim")
        for name in COMMAND_SURFACE:
            self.assertIn(name, help_out,
                          "banner offers %r but --help never documents it"
                          % name)

    def test_help_names_every_registry_report_format(self):
        # (b) Adding an emitter to einvoice.report.REPORT_FORMATS without
        # documenting it must FAIL here. capabilities()['formats'] is the same
        # list `einvoice info --json` publishes.
        _, out, _ = _run(["--help"])
        formats = einvoice.capabilities()["formats"]
        self.assertGreaterEqual(len(formats), 9, "registry looks truncated")
        missing = [f for f in formats if f not in out]
        self.assertEqual(
            missing, [],
            "help never names report format(s) %r — a wheel-only user cannot "
            "discover them" % (missing,))

    def test_help_points_at_the_report_entry_point_for_the_other_formats(self):
        _, out, _ = _run(["--help"])
        self.assertIn(
            "python3 -m einvoice.report", out,
            "help must name the sibling entry point that emits the CI formats")

    def test_help_only_advertises_real_output_forms(self):
        # T-VHERG.4 replaced the "this CLI has no --format" contract with a real
        # flag, so this guard now pins the STRONGER property: the synopsis must
        # advertise --format on BOTH validating subcommands (an ERP adopter reads
        # the usage line, and before T-VHERG.4 `--format` appeared only on the
        # sibling-entry-point line, so 7 of 9 advertised formats were invisible
        # there), and every output form the help mentions must be a real one.
        _, out, _ = _run(["--help"])
        for form in OUTPUT_FORMATS:
            self.assertIn(form, out,
                          "help should mention output form %r" % form)
        synopsis = [ln for ln in USAGE.splitlines() if "einvoice validate" in ln]
        self.assertEqual(
            len(synopsis), 2,
            "expected exactly the validate + validate-batch synopsis lines: %r"
            % synopsis)
        for line in synopsis:
            self.assertIn(
                "--format", line,
                "the synopsis line %r must document --format — the console "
                "script emits every registry format, not just text/json" % line)
        # No PHANTOM format name anywhere in the help: every lowercase word that
        # follows a `--format` mention as a value must be in the registry.
        for value in re.findall(r"--format[=\s]+([a-z]+)", out):
            if value in ("fmt",):
                continue
            self.assertIn(
                value, REPORT_FORMATS,
                "help advertises --format %r, which is not in REPORT_FORMATS"
                % value)

    def test_this_cli_really_accepts_the_format_flag(self):
        # Behavioural counterpart to the string check above: every format the
        # help names must genuinely WORK on the console script, and a bogus one
        # must be a usage error naming the valid set. This is the regression
        # guard for the T-VHERG.4 defect — `einvoice validate --format sarif`
        # used to exit 2 with "unexpected argument '--format'" while
        # `einvoice info` advertised sarif as a capability of the same build.
        fixture = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "corpus", "vendored", "valid",
                               "cen-bis3-positive_ubl.xml")
        self.assertTrue(os.path.exists(fixture), "fixture went missing")
        for fmt in REPORT_FORMATS:
            with self.subTest(fmt=fmt):
                code, out, err = _run(["validate", "--format", fmt, fixture])
                self.assertEqual(
                    code, EXIT_OK,
                    "einvoice validate --format %s must run and pass this "
                    "conformant fixture (stderr: %r)" % (fmt, err))
                self.assertTrue(
                    out, "--format %s emitted nothing on stdout" % fmt)
        # --format json is an EXACT alias for --json (same code path).
        _c1, json_out, _e1 = _run(["validate", "--json", fixture])
        _c2, fmt_out, _e2 = _run(["validate", "--format", "json", fixture])
        self.assertEqual(fmt_out, json_out,
                         "--format json must be byte-identical to --json")
        # An unknown format is a usage error naming the valid formats.
        code, out, err = _run(["validate", "--format", "nosuchfmt", fixture])
        self.assertEqual(code, EXIT_USAGE)
        self.assertEqual(out, "", "a usage error must not write to stdout")
        for fmt in REPORT_FORMATS:
            self.assertIn(fmt, err,
                          "the unknown-format error must name %r" % fmt)

    def test_delegated_bodies_are_byte_equal_to_the_sibling_entry_point(self):
        # The point of routing rather than forking: for the seven delegated
        # formats the console script and `python3 -m einvoice.report` must emit
        # the SAME bytes for the same invoice and profile, because they call the
        # same einvoice.report.render_report dispatch. Pinned on a fixture that
        # actually carries findings, so an empty body cannot make this vacuous.
        here = os.path.dirname(os.path.abspath(__file__))
        fixture = os.path.join(here, "examples", "01-missing-fields",
                               "broken.xml")
        self.assertTrue(os.path.isfile(fixture), fixture)
        profile = "xrechnung"  # the profile under which this fixture has fatals
        for fmt in DELEGATED_FORMATS:
            with self.subTest(fmt=fmt):
                _c, cli_out, _e = _run(["validate", "--format", fmt,
                                        "--profile", profile, fixture])
                out, err = io.StringIO(), io.StringIO()
                with redirect_stdout(out), redirect_stderr(err):
                    report_main(["--format", fmt, "--profile", profile,
                                 fixture])
                self.assertTrue(cli_out.strip(), "%s emitted nothing" % fmt)
                self.assertEqual(
                    cli_out, out.getvalue(),
                    "einvoice validate --format %s drifted from "
                    "python3 -m einvoice.report --format %s" % (fmt, fmt))
        # Non-vacuity: the fixture really does carry fatals under this profile,
        # so the compared bodies are non-trivial.
        code, _o, _e = _run(["validate", "--profile", profile, fixture])
        self.assertEqual(code, 1, "fixture no longer has fatals under %s"
                         % profile)

    def test_batch_format_subset_is_enforced_not_invented(self):
        # validate-batch accepts the aggregate-capable subset and refuses the
        # single-invoice emitters with an actionable usage error rather than
        # inventing an aggregate shape for them.
        here = os.path.dirname(os.path.abspath(__file__))
        batch_dir = os.path.join(here, "examples", "01-missing-fields")
        self.assertTrue(os.path.isdir(batch_dir), batch_dir)
        for fmt in BATCH_FORMATS:
            with self.subTest(fmt=fmt):
                code, out, err = _run(["validate-batch", "--format", fmt,
                                       batch_dir])
                self.assertNotEqual(
                    code, EXIT_USAGE,
                    "validate-batch --format %s must be accepted (stderr: %r)"
                    % (fmt, err))
                self.assertTrue(out, "--format %s emitted nothing" % fmt)
        for fmt in set(DELEGATED_FORMATS) - set(BATCH_FORMATS):
            with self.subTest(fmt=fmt):
                code, out, err = _run(["validate-batch", "--format", fmt,
                                       batch_dir])
                self.assertEqual(
                    code, EXIT_USAGE,
                    "validate-batch --format %s has no aggregate shape and "
                    "must be a usage error, not an invented document" % fmt)
                self.assertEqual(out, "")
                self.assertIn("einvoice validate --format=%s" % fmt, err,
                              "the error must name the per-file command")

    def test_json_and_format_together_are_a_clean_usage_error(self):
        fixture = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "corpus", "vendored", "valid",
                               "cen-bis3-positive_ubl.xml")
        for argv in (["validate", "--json", "--format", "sarif", fixture],
                     ["validate", "--format", "sarif", "--format", "json",
                      fixture]):
            with self.subTest(argv=argv):
                code, out, err = _run(argv)
                self.assertEqual(
                    code, EXIT_USAGE,
                    "%r must be a usage error, never a silent last-wins" % argv)
                self.assertEqual(out, "")
                self.assertIn("error:", err)
                self.assertNotIn("Traceback", err)

    def test_short_h_is_byte_identical_to_long_help(self):
        _, out_long, _ = _run(["--help"])
        _, out_short, _ = _run(["-h"])
        self.assertEqual(
            out_short, out_long,
            "-h must produce byte-identical output to --help")

    def test_help_precedes_dispatch_anywhere_in_argv(self):
        # Like --version, --help wins even after a would-be subcommand token.
        code, out, _ = _run(["validate", "--help"])
        self.assertEqual(code, EXIT_OK)
        self.assertIn("usage: einvoice", out)

    def test_mistyped_subcommand_still_errors(self):
        # No regression: a genuine typo (no -h/--help) still exits 2.
        code, _, err = _run(["bogus", "/tmp/nope.xml"])
        self.assertEqual(code, 2)
        self.assertIn("unknown subcommand", err)


class ReportHelpFlagTest(unittest.TestCase):
    """``python3 -m einvoice.report`` is a DOCUMENTED public entry point (the
    GitHub Action, README, QUICKSTART and every CI recipe invoke it), but until
    T-VHWHEEL.2 it answered ``--help`` with the nonsense ``error: no such file:
    --help`` and exited 1 — the argument loop fell through to the positional
    path check. MEASURED at 4d5adb6, both ``--help`` and ``-h``.

    Help is a REQUESTED output, so it goes to stdout with exit 0. The BARE
    invocation is a different thing — a usage ERROR — and keeps its pinned
    contract (usage on stderr, non-zero, empty stdout); that split is what
    test_stdout_purity.py's machine-surface discipline relies on.
    """

    def test_help_exits_ok_with_usage_on_stdout(self):
        code, out, err = _run_report(["--help"])
        self.assertEqual(code, 0, "report --help must exit 0")
        self.assertIn("usage:", out)
        self.assertIn(REPORT_USAGE, out,
                      "--help must print the module's own USAGE constant")
        self.assertEqual(err, "", "--help must not write to stderr")

    def test_short_h_is_byte_identical_to_long_help(self):
        _, out_long, _ = _run_report(["--help"])
        code, out_short, err = _run_report(["-h"])
        self.assertEqual(code, 0, "report -h must exit 0")
        self.assertEqual(out_short, out_long,
                         "-h must produce byte-identical output to --help")
        self.assertEqual(err, "")

    def test_help_wins_before_any_path_resolution(self):
        # The defect was that --help reached the positional/isfile check. Prove
        # it is answered first even when a bogus path is also on argv.
        for argv in (["/tmp/definitely-not-here.xml", "--help"],
                     ["--format", "sarif", "--help"],
                     ["-h", "/tmp/definitely-not-here.xml"]):
            with self.subTest(argv=argv):
                code, out, err = _run_report(argv)
                self.assertEqual(code, 0, "help must win over %r" % (argv,))
                self.assertIn("usage:", out)
                self.assertNotIn("no such file", out + err)

    def test_bare_invocation_keeps_its_pinned_error_contract(self):
        # NOT changed by the --help work: no args is a usage ERROR.
        code, out, err = _run_report([])
        self.assertNotEqual(code, 0,
                            "bare `python3 -m einvoice.report` must stay non-zero")
        self.assertEqual(out, "", "a usage error must keep stdout empty")
        self.assertIn("usage:", err, "bare invocation prints usage on stderr")


class WheelResolvablePointerTest(unittest.TestCase):
    """(c) No runtime message may point at a file the wheel does not ship.

    ``pip install verifyhash-einvoice`` puts the PACKAGE on disk and nothing
    else: README.md, EXIT-CODES.md, REPORT-SCHEMA.md, REPORT-FORMATS.md,
    COVERAGE.md and CORRECTNESS.md all live in the git checkout only. Telling a
    pip-only adopter to "See README.md" is a dead end at exactly the moment of
    confusion, so every runtime pointer must be a URL instead. The data-path
    sweep (packaging the docs) was closed deliberately — a URL is the fix.

    Docstrings and ``#:`` comments are NOT runtime messages and are explicitly
    out of scope: they are read in the source tree, where the files DO exist.
    """

    def _runtime_string_constants(self, module):
        """Every non-docstring string literal in ``module``'s source, as
        (lineno, value) — i.e. the strings that can reach a user's terminal."""
        import ast
        with open(module.__file__, encoding="utf-8") as fh:
            tree = ast.parse(fh.read())
        docstrings = set()
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef,
                                 ast.AsyncFunctionDef)):
                body = node.body
                if (body and isinstance(body[0], ast.Expr)
                        and isinstance(body[0].value, ast.Constant)
                        and isinstance(body[0].value.value, str)):
                    docstrings.add(id(body[0].value))
        return [(n.lineno, n.value) for n in ast.walk(tree)
                if isinstance(n, ast.Constant) and isinstance(n.value, str)
                and id(n) not in docstrings]

    def test_no_runtime_string_in_cli_or_report_names_a_md_file(self):
        import einvoice.cli as cli_mod
        import einvoice.report as report_mod
        offenders = []
        for module in (cli_mod, report_mod):
            for lineno, value in self._runtime_string_constants(module):
                for hit in _MD_TOKEN.findall(value):
                    offenders.append("%s:%d names %s"
                                     % (os.path.basename(module.__file__),
                                        lineno, hit))
        self.assertEqual(
            offenders, [],
            "runtime message(s) point at a doc file absent from the wheel — "
            "use an https://verifyhash.com/einvoice/ URL instead: %s"
            % "; ".join(offenders))

    def test_rendered_help_of_both_entry_points_is_md_free(self):
        # The live counterpart to the static scan: whatever a user actually
        # sees from either --help must be free of *.md pointers.
        _, cli_help, _ = _run(["--help"])
        _, report_help, _ = _run_report(["--help"])
        for label, text in (("einvoice --help", cli_help),
                            ("einvoice.report --help", report_help)):
            self.assertEqual(
                _MD_TOKEN.findall(text), [],
                "%s still names a repo-only doc file" % label)

    def test_help_carries_a_resolvable_docs_url(self):
        _, out, _ = _run(["--help"])
        self.assertIn(
            "https://verifyhash.com/einvoice/", out,
            "help must point at the published docs page a wheel-only user "
            "can actually open")

    def test_the_help_constant_matches_what_is_printed(self):
        # Cheap anti-drift check: the guards above scan the printed output, so
        # pin that the printed output really is the HELP constant.
        _, out, _ = _run(["--help"])
        self.assertEqual(out, HELP + "\n")


if __name__ == "__main__":
    unittest.main(verbosity=2)

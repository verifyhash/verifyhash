#!/usr/bin/env python3
"""test_cli.py — pin the einvoice CLI ergonomics contract (T-VHCLI.1).

Fast, stdlib-only, offline. Exercises the hand-rolled CLI both in-process
(``einvoice.cli.main`` with an argv list, capturing stdout/stderr) and as a
subprocess (``python3 -m einvoice``) to prove the packaged entry point behaves
identically.

What this locks down — each maps to a task acceptance criterion:
  * ``--version`` exits 0 and prints ``einvoice.__version__`` (no hardcoded
    literal — the test reads the package attribute), with no subcommand/file.
  * ``--quiet`` on a PASSING invoice emits NO human stdout but still exit 0.
  * ``--quiet`` on a FAILING invoice emits NO human stdout but still exit 1.
  * ``--quiet --json`` STILL prints the JSON result (quiet only silences the
    human summary), byte-identical to plain ``--json``.
  * The four documented exit codes still hold: 0 pass, 1 fatal fail, 2 usage,
    3 not-well-formed.
  * ``validate -`` reads XML from stdin and yields the SAME verdict/exit code
    (and same JSON minus the ``source`` label) as validating the file on disk,
    WITHOUT relaxing the hardened parser.

These assertions are additive: they must never require changing the validation
output, the exit codes, or the --json shape.
"""

import io
import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import einvoice  # noqa: E402
from einvoice.cli import (  # noqa: E402
    main, EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE,
)

WRAPPER = os.path.join(HERE, "einvoice.py")

# A committed, business-rule-clean UBL invoice -> exit 0 (default en16931).
PASS_FIXTURE = os.path.join(HERE, "corpus", "vendored", "valid",
                            "cen-bis3-positive_ubl.xml")
# A committed invalid UBL *CreditNote* (BT-3 CreditNoteTypeCode = 999, an
# out-of-range UNTDID 1001 credit-note code) -> a REAL BR-CL-01 fatal from the
# CreditNote rule engine -> exit 1. (Since T-VHCN.2 a UBL CreditNote is really
# validated, not S-ROOT-rejected, so a failing CreditNote fails on its content.)
FAIL_FIXTURE = os.path.join(HERE, "fixtures",
                            "creditnote-invalid-typecode_ubl.xml")
# Deliberately truncated XML -> not-well-formed -> exit 3.
MALFORMED_XML = b"<Invoice><never-closed>"


class _Capture:
    """Context manager: run ``main(argv)`` capturing stdout/stderr + exit code.

    Optionally feeds ``stdin`` (bytes) so the ``validate -`` path can be driven
    in-process. Restores the real streams afterwards.
    """

    def __init__(self, argv, stdin_bytes=None):
        self.argv = argv
        self.stdin_bytes = stdin_bytes
        self.rc = None
        self.out = ""
        self.err = ""

    def __enter__(self):
        self._out, self._err, self._in = sys.stdout, sys.stderr, sys.stdin
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
        if self.stdin_bytes is not None:
            # main() reads stdin via sys.stdin.buffer.read(); emulate that.
            text = io.TextIOWrapper(io.BytesIO(self.stdin_bytes),
                                    encoding="utf-8")
            sys.stdin = text
        self.rc = main(self.argv)
        self.out = sys.stdout.getvalue()
        self.err = sys.stderr.getvalue()
        return self

    def __exit__(self, *exc):
        sys.stdout, sys.stderr, sys.stdin = self._out, self._err, self._in
        return False


def run_module(*argv, stdin=None):
    """Run ``python3 -m einvoice <argv>`` as a subprocess."""
    return subprocess.run(
        [sys.executable, "-m", "einvoice", *argv],
        cwd=HERE, input=stdin, capture_output=True)


class FixturesExist(unittest.TestCase):
    def test_fixtures_present(self):
        self.assertTrue(os.path.isfile(PASS_FIXTURE), PASS_FIXTURE)
        self.assertTrue(os.path.isfile(FAIL_FIXTURE), FAIL_FIXTURE)


class Version(unittest.TestCase):
    def test_version_inprocess_exit0_prints_package_version(self):
        with _Capture(["--version"]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)
            self.assertIn(einvoice.__version__, cap.out)
            # No subcommand / file was needed.
            self.assertEqual(cap.err, "")

    def test_version_takes_precedence_over_subcommand(self):
        # --version short-circuits even when a (nonexistent) file follows.
        with _Capture(["validate", "--version", "nope.xml"]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)
            self.assertIn(einvoice.__version__, cap.out)

    def test_version_subprocess_module(self):
        proc = run_module("--version")
        self.assertEqual(proc.returncode, EXIT_OK, proc.stderr)
        self.assertIn(einvoice.__version__,
                      proc.stdout.decode("utf-8", "replace"))

    def test_version_not_hardcoded_but_the_package_attr(self):
        # Guard against a future edit that hardcodes a literal: the printed
        # token must equal whatever einvoice.__version__ currently is.
        with _Capture(["--version"]) as cap:
            self.assertEqual(cap.out.strip().split()[-1], einvoice.__version__)


class Quiet(unittest.TestCase):
    def test_quiet_pass_emits_no_human_stdout_exit0(self):
        with _Capture(["validate", "--quiet", PASS_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)
            self.assertEqual(cap.out, "", "quiet must silence the PASS summary")

    def test_quiet_fail_emits_no_human_stdout_exit1(self):
        with _Capture(["validate", "--quiet", FAIL_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_FAIL)
            self.assertEqual(cap.out, "", "quiet must silence the FAIL summary")

    def test_quiet_does_not_change_the_exit_code(self):
        for fixture in (PASS_FIXTURE, FAIL_FIXTURE):
            with _Capture(["validate", fixture]) as loud, \
                    _Capture(["validate", "--quiet", fixture]) as hush:
                self.assertEqual(loud.rc, hush.rc, fixture)

    def test_quiet_json_still_prints_json_byte_identical(self):
        with _Capture(["validate", "--json", PASS_FIXTURE]) as plain, \
                _Capture(["validate", "--quiet", "--json", PASS_FIXTURE]) as q:
            self.assertEqual(q.rc, plain.rc)
            # quiet only silences the HUMAN summary; JSON is untouched.
            self.assertEqual(q.out, plain.out)
            json.loads(q.out)  # still parseable

    def test_quiet_json_on_failure_still_prints_json(self):
        with _Capture(["validate", "--quiet", "--json", FAIL_FIXTURE]) as q:
            self.assertEqual(q.rc, EXIT_FAIL)
            doc = json.loads(q.out)
            self.assertFalse(doc["valid"])


class ExitCodeContract(unittest.TestCase):
    """The four documented exit codes still hold byte-for-byte on existing
    paths — nothing in this task may have moved them."""

    def test_0_pass(self):
        with _Capture(["validate", PASS_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)
            self.assertTrue(cap.out.startswith("PASS: "), cap.out)

    def test_1_fatal_fail(self):
        with _Capture(["validate", FAIL_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_FAIL)
            self.assertTrue(cap.out.startswith("FAIL: "), cap.out)

    def test_2_usage_missing_file(self):
        with _Capture(["validate", "does-not-exist.xml"]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)

    def test_2_usage_no_subcommand(self):
        with _Capture([]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)
            self.assertIn("usage:", cap.err)

    def test_2_usage_unknown_profile(self):
        with _Capture(["validate", "--profile=bogus", PASS_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)

    def test_3_not_well_formed(self):
        # Write the malformed bytes to a temp file so this exercises the normal
        # (non-stdin) parse path.
        import tempfile
        fd, tmp = tempfile.mkstemp(suffix=".xml")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(MALFORMED_XML)
            with _Capture(["validate", tmp]) as cap:
                self.assertEqual(cap.rc, EXIT_PARSE)
        finally:
            os.unlink(tmp)


class HumanOutputUnchanged(unittest.TestCase):
    """The non-quiet human summary is byte-identical to the historical format
    (the '--quiet' work must not have perturbed the loud path)."""

    def test_pass_summary_shape(self):
        with _Capture(["validate", PASS_FIXTURE]) as cap:
            self.assertIn("(all implemented fatal rules, profile=en16931)",
                          cap.out)
            self.assertIn("Syntax-binding warnings:", cap.out)


class Stdin(unittest.TestCase):
    """`validate -` reads XML from stdin and matches the file-path verdict,
    without relaxing the hardened parser."""

    def _read(self, path):
        with open(path, "rb") as fh:
            return fh.read()

    def test_stdin_pass_matches_file(self):
        with _Capture(["validate", PASS_FIXTURE]) as onfile, \
                _Capture(["validate", "-"],
                         stdin_bytes=self._read(PASS_FIXTURE)) as onstdin:
            self.assertEqual(onstdin.rc, onfile.rc)
            self.assertEqual(onstdin.rc, EXIT_OK)

    def test_stdin_fail_matches_file(self):
        with _Capture(["validate", FAIL_FIXTURE]) as onfile, \
                _Capture(["validate", "-"],
                         stdin_bytes=self._read(FAIL_FIXTURE)) as onstdin:
            self.assertEqual(onstdin.rc, onfile.rc)
            self.assertEqual(onstdin.rc, EXIT_FAIL)

    def test_stdin_json_matches_file_except_source(self):
        with _Capture(["validate", "--json", PASS_FIXTURE]) as onfile, \
                _Capture(["validate", "--json", "-"],
                         stdin_bytes=self._read(PASS_FIXTURE)) as onstdin:
            a = json.loads(onfile.out)
            b = json.loads(onstdin.out)
            # Only the human-facing 'source' label differs ("-" vs the path);
            # every other field of the --json shape is identical.
            a.pop("source"), b.pop("source")
            self.assertEqual(a, b)
            self.assertEqual(b_source_label(onstdin.out), "-")

    def test_stdin_malformed_is_still_exit3(self):
        with _Capture(["validate", "-"], stdin_bytes=MALFORMED_XML) as cap:
            self.assertEqual(cap.rc, EXIT_PARSE)

    def test_stdin_hardening_not_relaxed_xxe_rejected(self):
        # A classic external-entity (XXE) payload must be refused on the stdin
        # path exactly as on the file path: not-well-formed / parse error (3),
        # never entity expansion. Proves stdin routes through the hardened
        # parser (einvoice._xmlsec), not a relaxed reader.
        xxe = (b'<?xml version="1.0"?>\n'
               b'<!DOCTYPE Invoice [<!ENTITY xxe SYSTEM '
               b'"file:///etc/passwd">]>\n'
               b'<Invoice>&xxe;</Invoice>')
        with _Capture(["validate", "-"], stdin_bytes=xxe) as cap:
            self.assertEqual(cap.rc, EXIT_PARSE, cap.out + cap.err)
            self.assertNotIn("root:", cap.out)
            self.assertNotIn("root:", cap.err)

    def test_stdin_subprocess_module(self):
        proc = run_module("validate", "-", stdin=self._read(PASS_FIXTURE))
        self.assertEqual(proc.returncode, EXIT_OK, proc.stderr)


def b_source_label(json_text):
    return json.loads(json_text).get("source")


class UsageErrorNamesTheOffendingToken(unittest.TestCase):
    """First-run ergonomics: a mistyped subcommand or flag must NAME what was
    wrong (and, for subcommands, the valid set), while every existing usage
    error keeps exit code 2 and the bare-usage cases stay bare."""

    def test_unknown_subcommand_names_token_and_valid_set_exit2(self):
        with _Capture(["bogusverb", "x.xml"]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)
            self.assertIn("unknown subcommand", cap.err)
            self.assertIn("bogusverb", cap.err)
            # The valid set is surfaced from the single-source tuple.
            for verb in ("validate", "validate-batch", "receipt"):
                self.assertIn(verb, cap.err)
            self.assertIn("usage:", cap.err)

    def test_unknown_flag_is_named_exit2(self):
        with _Capture(["validate", "--badflag", PASS_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)
            self.assertIn("--badflag", cap.err)
            # A stray flag is NOT a "unknown subcommand" — different leg.
            self.assertNotIn("unknown subcommand", cap.err)

    def test_missing_file_is_not_falsely_an_unknown_subcommand(self):
        # REGRESSION: a VALID subcommand with a missing file keeps its existing
        # bare-usage error and must never be mislabelled "unknown subcommand".
        with _Capture(["validate", "does-not-exist.xml"]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)
            self.assertNotIn("unknown subcommand", cap.err)

    def test_no_subcommand_stays_bare_usage(self):
        with _Capture([]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)
            self.assertNotIn("unknown subcommand", cap.err)
            self.assertIn("usage:", cap.err)

    def test_valid_subcommand_missing_argument_stays_bare_usage(self):
        # `validate` with no file at all: len(args) < 2 but args[0] is valid,
        # so the plain USAGE block (not the unknown-subcommand line) is shown.
        with _Capture(["validate"]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)
            self.assertNotIn("unknown subcommand", cap.err)

    def test_error_message_valid_set_matches_the_dispatch_tuple(self):
        # The message is driven by the SAME tuple the dispatcher checks, so it
        # can never drift from what is actually accepted.
        from einvoice.cli import VALID_SUBCOMMANDS
        with _Capture(["bogusverb"]) as cap:
            for verb in VALID_SUBCOMMANDS:
                self.assertIn(verb, cap.err)

    def test_unknown_subcommand_subprocess_exit2(self):
        proc = run_module("bogusverb", "x.xml")
        self.assertEqual(proc.returncode, EXIT_USAGE)
        self.assertIn(b"unknown subcommand",
                      proc.stderr)


# --------------------------------------------------------------------------
# `validate --json` carries the remediation catalog (T-VHERG.1)
# --------------------------------------------------------------------------
# MEASURED BEFORE this feature: a `validate --json` violation carried exactly
# ['element', 'message', 'rule', 'severity'] while `python3 -m einvoice.report
# --format json` on the SAME file carried ['field', 'fix_hint', 'location',
# 'message', 'rule', 'severity', 'terms', 'title'] — the actionable half. The
# CLI is the surface a CI job parses, so the shipped remediation catalog was
# invisible exactly where it is felt daily. These tests pin the enriched shape,
# the back-compat keys it must NOT disturb, and the degradation on a rule the
# catalog does not cover.

#: A UBL invoice that fires four XRechnung-profile violations across three
#: severities (BR-CO-14 fatal, BR-DE-19/-21 warning, BR-DE-TMP-32 information).
ENRICHED_FIXTURE = os.path.join(HERE, "corpus", "synthetic",
                                "synth-ubl-bad-vat-mismatch.xml")

#: Every key a `validate --json` violation record must ALWAYS carry: the four
#: frozen identity keys plus the five added by T-VHERG.1.
ENRICHED_KEYS = frozenset((
    "rule", "message", "element", "severity",
    "field", "title", "fix_hint", "terms", "location"))


def validate_json(*argv):
    """Run the REAL CLI with --json and return (parsed doc, returncode)."""
    proc = run_module("validate", "--json", *argv)
    return json.loads(proc.stdout.decode("utf-8")), proc.returncode


class ValidateJsonCarriesRemediation(unittest.TestCase):
    def test_every_violation_carries_the_full_enriched_key_set(self):
        doc, _rc = validate_json("--profile", "xrechnung", ENRICHED_FIXTURE)
        self.assertTrue(doc["violations"], "fixture must fire violations")
        for rec in doc["violations"]:
            self.assertEqual(ENRICHED_KEYS - set(rec), set(),
                             "missing keys on %r" % rec.get("rule"))

    def test_field_is_the_same_datum_as_element(self):
        # `field` is the report writer's NAME for `element`, not a new datum.
        # Both are emitted so one consumer parses either surface.
        doc, _rc = validate_json("--profile", "xrechnung", ENRICHED_FIXTURE)
        for rec in doc["violations"]:
            self.assertEqual(rec["field"], rec["element"], rec["rule"])

    def test_values_are_relayed_verbatim_from_the_committed_catalog(self):
        # Not "non-null" — the exact committed wording, so a placeholder or a
        # locally-authored string would fail here.
        from einvoice.remediation import load_catalog
        catalog = load_catalog()
        doc, _rc = validate_json("--profile", "xrechnung", ENRICHED_FIXTURE)
        checked = 0
        for rec in doc["violations"]:
            entry = catalog.get(rec["rule"])
            if entry is None:
                continue
            self.assertEqual(rec["title"], entry["title"])
            self.assertEqual(rec["fix_hint"], entry["fix"])
            self.assertEqual(rec["location"], entry["location_hint"])
            self.assertEqual(rec["terms"], list(entry["bt_bg"]))
            checked += 1
        self.assertGreater(checked, 0, "no catalogued rule fired")

    def test_uncatalogued_rule_still_emits_every_key_as_null_or_empty(self):
        # S-ROOT is a STRUCTURAL refusal, not a graded business rule, so it is
        # deliberately absent from the catalog: the shape must stay
        # unconditional (present-and-empty), never drop keys.
        import tempfile
        fd, path = tempfile.mkstemp(suffix=".xml")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(b'<?xml version="1.0"?>\n<Nonsense xmlns="urn:x"/>\n')
            doc, _rc = validate_json(path)
            rec = doc["violations"][0]
            self.assertNotIn(rec["rule"], load_catalog_ids())
            self.assertEqual(ENRICHED_KEYS - set(rec), set())
            self.assertIsNone(rec["title"])
            self.assertIsNone(rec["fix_hint"])
            self.assertIsNone(rec["location"])
            self.assertEqual(rec["terms"], [])
            # ...and the identity keys are still real.
            self.assertEqual(rec["element"], "Nonsense")
            self.assertEqual(rec["severity"], "fatal")
        finally:
            os.unlink(path)

    def test_source_line_stays_conditional(self):
        # The one genuinely optional key: present for a violation attributable
        # to a concrete element position, ABSENT otherwise. Enrichment must not
        # have turned it into an always-present null.
        doc, _rc = validate_json(FAIL_FIXTURE)
        with_line = [r for r in doc["violations"] if "source_line" in r]
        self.assertTrue(with_line,
                        "BR-CL-01 fixture must still carry a source_line")
        self.assertIsInstance(with_line[0]["source_line"], int)
        doc2, _rc2 = validate_json("--profile", "xrechnung", ENRICHED_FIXTURE)
        without = [r for r in doc2["violations"] if "source_line" not in r]
        self.assertTrue(without,
                        "an absence/document-level finding must still OMIT "
                        "source_line, not emit it as null")

    def test_parity_with_the_report_surface_on_the_shared_keys(self):
        # The two surfaces read ONE catalog through ONE helper, so on the same
        # file under the same profile they must agree on the finding list and
        # on every shared key.
        doc, _rc = validate_json("--profile", "xrechnung", ENRICHED_FIXTURE)
        proc = subprocess.run(
            [sys.executable, "-m", "einvoice.report", "--format", "json",
             "--profile", "xrechnung", ENRICHED_FIXTURE],
            cwd=HERE, capture_output=True)
        report = json.loads(proc.stdout.decode("utf-8"))
        self.assertEqual(doc["violation_count"], report["violation_count"])
        for cli_rec, rep_rec in zip(doc["violations"], report["violations"]):
            for key in ("rule", "severity", "message", "field",
                        "title", "fix_hint", "terms", "location"):
                self.assertEqual(cli_rec[key], rep_rec[key],
                                 "%s disagrees on %r" % (cli_rec["rule"], key))

    def test_human_text_output_is_untouched_by_enrichment(self):
        # The remediation relay is a --json-only change: the human summary must
        # not gain a line, and the exit code contract is unchanged.
        proc = run_module("validate", "--profile", "xrechnung",
                          ENRICHED_FIXTURE)
        self.assertEqual(proc.returncode, EXIT_FAIL)
        text = proc.stdout.decode("utf-8")
        for token in ("fix_hint", "title", "terms", "location"):
            self.assertNotIn(token, text)

    def test_validate_module_does_not_import_report(self):
        # The relay imports einvoice.remediation directly: einvoice.report
        # imports einvoice.validate, so the reverse edge would be circular.
        import einvoice.validate as validate_mod
        with open(validate_mod.__file__, encoding="utf-8") as fh:
            source = fh.read()
        for line in source.splitlines():
            stripped = line.strip()
            if stripped.startswith(("import ", "from ")):
                self.assertNotIn("report", stripped, line)


def load_catalog_ids():
    from einvoice.remediation import load_catalog
    return set(load_catalog())


if __name__ == "__main__":
    unittest.main()

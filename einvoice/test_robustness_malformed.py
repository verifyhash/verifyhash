#!/usr/bin/env python3
"""test_robustness_malformed.py — malformed-shape CLI resilience audit.

Real supplier intake feeds this validator arbitrary garbage. The product
promise for such input is narrow and absolute: **clean-error, never crash,
never hang, never false-green**. Where ``test_robustness.py`` and
``test_exit_codes.py`` already prove pieces of that at the internal
``report.build_report`` boundary (or the in-process ``cli.main``), this suite
closes the DISJOINT gap by asserting the contract at the *real process
boundary* a caller actually sees — an honest ``subprocess`` run of the shipped
``einvoice.py validate <file>`` — for each malformed SHAPE. For every case it
pins all three legs of the promise together:

  (i)   the EXACT process exit code from ``EXIT-CODES.md`` (measured, then
        pinned — 0 pass / 1 fatal / 2 usage / 3 not-well-formed);
  (ii)  a NON-EMPTY, greppable, actionable message on the DOCUMENTED stream
        naming the reason (``S-WF`` for not-well-formed on stderr; ``FAIL`` +
        the fatal rule id — ``S-ROOT`` / ``BR-CO-10`` — on stdout);
  (iii) NO ``Traceback (most recent call last)`` in either stream, and — via a
        per-case wall-clock ``subprocess`` timeout — no hang (a hang FAILS the
        test instead of blocking the suite).

Cases (each measured against the live CLI at HEAD, not assumed):

  (c) truncated XML / garbled bytes  -> exit 3, ``S-WF`` on stderr.
      Also proven in-process by ``test_robustness.TestTruncatedGarbled`` and
      ``test_exit_codes.ExitCode3``; VERIFIED-AND-CLOSED here at the real
      process boundary.
  (e) empty / zero-byte file         -> exit 3, ``S-WF`` on stderr.
      Also proven by ``test_robustness.TestEmptyInput`` (build_report boundary);
      VERIFIED-AND-CLOSED here at the process boundary.
  (d) wrong root element / namespace -> exit 1, ``FAIL`` + ``S-ROOT`` on stdout.
      Also proven by ``test_robustness.TestWrongRoot``; VERIFIED-AND-CLOSED.
  (NEW) valid, well-formed XML that is not an invoice at all (a plausible
      ``<html>…</html>`` page) -> MEASURED and pinned to the real documented
      outcome: it is NOT a separate "unsupported" code, it trips the structural
      fatal ``S-ROOT`` and surfaces as exit 1 with an actionable ``FAIL`` — never
      exit 0. (See EXIT-CODES.md "Honest note on unsupported / out-of-scope
      inputs".)
  (NEW) a well-formed but structurally-odd document: an otherwise-valid UBL
      invoice with a DUPLICATED ``<cac:InvoiceLine>`` block. MEASURED and pinned:
      it does NOT silently pass — the duplicated line makes the summed line net
      amount disagree with ``BT-106``, so the real EN 16931 calculation rule
      ``BR-CO-10`` fails fatally (exit 1, actionable ``FAIL``). ``--json`` on the
      same input reports ``"valid": false``, nailing "never valid=True exit 0".

Honest limit worth stating: this Schematron-style business-rule engine does not
enforce XSD 1..1 element cardinality, so duplicating a *singleton* leaf such as
a second invoice-level ``<cbc:ID>`` is tolerated (the first value wins) rather
than rejected — that is a schema-validator's job, not this tool's. A duplicated
*block* that perturbs a monetary total, by contrast, is caught by the real
business rules, which is the case pinned above.

This suite adds NO parser/rule change: every case already behaves correctly, so
it lands purely as a regression guard. It commits no large fixtures — the two
malformed UBL inputs are derived at runtime, minimally, from the committed
golden fixture ``corpus/.../standard/01.01a-INVOICE_ubl.xml``.

Standard library only. Runs offline. Run: python3 test_robustness_malformed.py
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# Symbolic exit codes come from the shipped CLI module so this test pins the
# SAME numbers EXIT-CODES.md documents (0/1/2/3), never hand-copied literals.
from einvoice.cli import (  # noqa: E402
    EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE,
)

CLI = os.path.join(HERE, "einvoice.py")
GOLDEN = os.path.join(
    HERE, "corpus", "xrechnung-testsuite", "src", "test",
    "business-cases", "standard", "01.01a-INVOICE_ubl.xml")

TRACEBACK_MARK = "Traceback (most recent call last)"

# A per-case wall-clock ceiling. Every legitimate run finishes in well under a
# second; a real hang / unbounded expansion blows past this and raises
# ``TimeoutExpired``, which the harness turns into a test FAILURE (never a
# blocked suite). Generous enough to survive a loaded CI box.
CASE_TIMEOUT_S = 30.0


def _load_golden():
    """Read the committed golden UBL invoice as text (the derivation base)."""
    with open(GOLDEN, encoding="utf-8") as fh:
        return fh.read()


def _dup_first_invoice_line(xml):
    """Return ``xml`` with its FIRST <cac:InvoiceLine> block duplicated.

    A well-formed but structurally-odd mutation: the extra line makes the summed
    line net amount disagree with BT-106, so BR-CO-10 fails — the document must
    NOT silently pass. Derived minimally at runtime (no fixture committed).
    """
    open_tag, close_tag = "<cac:InvoiceLine>", "</cac:InvoiceLine>"
    start = xml.index(open_tag)
    end = xml.index(close_tag, start) + len(close_tag)
    block = xml[start:end]
    return xml[:end] + "\n    " + block + xml[end:]


class _CLICase:
    """One real subprocess run of ``einvoice.py validate <file>``."""

    def __init__(self, rc, out, err):
        self.rc = rc
        self.out = out
        self.err = err

    @property
    def both(self):
        return self.out + self.err


class MalformedCLIBase(unittest.TestCase):
    """Shared driver + the invariant every malformed case must satisfy."""

    def _run_validate(self, data, *extra_args, suffix=".xml"):
        """Write ``data`` (bytes) to a temp file and drive the shipped CLI.

        Uses a per-case wall-clock timeout so a hang FAILS the test rather than
        hanging the suite; returns a :class:`_CLICase`. The temp file is always
        cleaned up.
        """
        if isinstance(data, str):
            data = data.encode("utf-8")
        fd, path = tempfile.mkstemp(suffix=suffix, prefix="einvoice-malformed-")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
            try:
                proc = subprocess.run(
                    [sys.executable, CLI, "validate", *extra_args, path],
                    capture_output=True, text=True, timeout=CASE_TIMEOUT_S)
            except subprocess.TimeoutExpired:
                self.fail("CLI hung > %.0fs on malformed input (%r) — a hang is "
                          "a robustness FAILURE, not an acceptable outcome"
                          % (CASE_TIMEOUT_S, extra_args))
            return _CLICase(proc.returncode, proc.stdout, proc.stderr)
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

    def _assert_no_traceback(self, case, label):
        self.assertNotIn(
            TRACEBACK_MARK, case.both,
            "%s leaked a Python traceback — malformed input must clean-error, "
            "not crash.\nstdout=%r\nstderr=%r" % (label, case.out, case.err))

    def _assert_not_wellformed(self, case, label):
        """The exit-3 contract: not-well-formed, S-WF on stderr, no traceback."""
        self.assertEqual(
            case.rc, EXIT_PARSE,
            "%s: expected not-well-formed exit %d, got %d\nstderr=%r"
            % (label, EXIT_PARSE, case.rc, case.err))
        self._assert_no_traceback(case, label)
        self.assertIn("S-WF", case.err,
                      "%s: missing greppable S-WF reason on stderr; got %r"
                      % (label, case.err))
        self.assertIn("not well-formed", case.err,
                      "%s: missing actionable 'not well-formed' text; got %r"
                      % (label, case.err))
        self.assertTrue(case.err.strip(), "%s: empty stderr message" % label)

    def _assert_fatal(self, case, label, rule_id):
        """The exit-1 contract: FAIL + a named fatal rule on stdout, non-pass."""
        self.assertEqual(
            case.rc, EXIT_FAIL,
            "%s: expected fatal exit %d, got %d\nstdout=%r\nstderr=%r"
            % (label, EXIT_FAIL, case.rc, case.out, case.err))
        self._assert_no_traceback(case, label)
        self.assertIn("FAIL:", case.out,
                      "%s: missing FAIL verdict on stdout; got %r"
                      % (label, case.out))
        self.assertIn(rule_id, case.out,
                      "%s: missing actionable rule id %r on stdout; got %r"
                      % (label, rule_id, case.out))
        # Never a false green: the success banner must be absent.
        self.assertNotIn("PASS:", case.out,
                         "%s wrongly reported PASS" % label)
        self.assertNotEqual(case.rc, EXIT_OK,
                            "%s silently passed (exit 0)" % label)


class TestFixturePresent(MalformedCLIBase):
    def test_golden_fixture_and_cli_present(self):
        self.assertTrue(os.path.isfile(GOLDEN),
                        "golden derivation fixture missing: %s" % GOLDEN)
        self.assertTrue(os.path.isfile(CLI), "shipped CLI missing: %s" % CLI)

    def test_golden_is_a_real_pass(self):
        """Control: the un-mutated golden fixture validates cleanly (exit 0).

        Proves the malformed cases below fail *because of the mutation*, not
        because the base document was already broken.
        """
        case = self._run_validate(_load_golden().encode("utf-8"))
        self.assertEqual(case.rc, EXIT_OK,
                         "golden base is not a clean PASS\nstdout=%r\nstderr=%r"
                         % (case.out, case.err))
        self.assertIn("PASS:", case.out)


class TestTruncatedGarbled(MalformedCLIBase):
    """(c) Truncated / garbled XML -> exit 3, S-WF. Also proven in-process by
    test_robustness.TestTruncatedGarbled and test_exit_codes.ExitCode3."""

    def test_truncated_invoice(self):
        golden = _load_golden()
        truncated = golden[: len(golden) // 2]  # cut mid-document, never closed
        case = self._run_validate(truncated)
        self._assert_not_wellformed(case, "truncated XML")

    def test_garbled_bytes(self):
        case = self._run_validate(b"<?xml version='1.0'?><\x00\x01\x02 not xml >>>")
        self._assert_not_wellformed(case, "garbled bytes")


class TestEmptyInput(MalformedCLIBase):
    """(e) Empty / zero-byte file -> exit 3, S-WF. Also proven in-process by
    test_robustness.TestEmptyInput."""

    def test_zero_byte_file(self):
        case = self._run_validate(b"")
        self._assert_not_wellformed(case, "zero-byte file")

    def test_whitespace_only_file(self):
        case = self._run_validate(b"   \n\t \n")
        self._assert_not_wellformed(case, "whitespace-only file")


class TestWrongRoot(MalformedCLIBase):
    """(d) Wrong root element / namespace -> exit 1, FAIL + S-ROOT. Also proven
    in-process by test_robustness.TestWrongRoot."""

    def test_unrelated_root_namespace(self):
        data = ('<catalog xmlns="urn:example:unrelated">'
                '<product>widget</product></catalog>')
        case = self._run_validate(data)
        self._assert_fatal(case, "unrelated root", "S-ROOT")


class TestNotAnInvoice(MalformedCLIBase):
    """(NEW) Valid, well-formed XML that is not an invoice at all (a plausible
    HTML page). MEASURED: no dedicated 'unsupported' code — it trips the
    structural S-ROOT fatal and surfaces as exit 1, never exit 0."""

    def test_html_document_is_fatal_not_silent_pass(self):
        data = ("<html><head><title>Invoice? no.</title></head>"
                "<body><h1>Statement of account</h1>"
                "<p>Total due: EUR 336.90</p></body></html>")
        case = self._run_validate(data)
        self._assert_fatal(case, "HTML (not an invoice)", "S-ROOT")


class TestStructurallyOddDuplicatedBlock(MalformedCLIBase):
    """(NEW) A well-formed but structurally-odd document — an otherwise-valid UBL
    invoice with a DUPLICATED <cac:InvoiceLine> block. MEASURED: it never
    silently passes; the duplicated line breaks the BR-CO-10 line-total identity,
    so it fails fatally (exit 1) with an actionable rule id."""

    def test_duplicated_invoice_line_fails_fatal(self):
        odd = _dup_first_invoice_line(_load_golden())
        case = self._run_validate(odd)
        self._assert_fatal(case, "duplicated InvoiceLine block", "BR-CO-10")

    def test_duplicated_invoice_line_json_is_not_valid(self):
        """The strongest form of "never valid=True exit 0": the --json payload
        for the same odd document explicitly reports ``"valid": false``."""
        odd = _dup_first_invoice_line(_load_golden())
        case = self._run_validate(odd, "--json")
        self.assertEqual(case.rc, EXIT_FAIL,
                         "duplicated-line --json expected exit %d, got %d"
                         % (EXIT_FAIL, case.rc))
        self._assert_no_traceback(case, "duplicated InvoiceLine (--json)")
        self.assertIn('"valid": false', case.out,
                      "duplicated-line report must be valid=false; got %r"
                      % case.out)


class TestNoUnusedExitCodesLeak(MalformedCLIBase):
    """Sanity: the malformed SHAPES above land only on the documented codes.
    (EXIT_OK / EXIT_USAGE are exercised by test_exit_codes.py; referenced here
    only so an accidental repurposing of a code shows up as a symbol error.)"""

    def test_exit_symbols_are_the_documented_values(self):
        self.assertEqual(
            (EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE), (0, 1, 2, 3))


if __name__ == "__main__":
    unittest.main(verbosity=2)

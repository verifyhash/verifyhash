#!/usr/bin/env python3
"""test_robustness.py — resource-bounding on legitimate-but-hostile XML.

The einvoice engine parses XML from untrusted suppliers. ``test_security.py``
covers the *entity / DTD / XXE* attack surface; this suite covers the disjoint
*well-formed-but-hostile* and *malformed* surface — inputs that carry no DTD and
no custom entities yet can still exhaust memory, blow the stack, hang, or crash
the parser by sheer size or shape, plus the everyday garbage a real intake sees
(truncated files, wrong root, empty files, mis-encoded bytes).

Each case (a)-(f) asserts the SAME contract: a **bounded, actionable, non-crash,
non-silent-pass** outcome, observed on the real engine output a caller sees via
the shipped public boundary ``report.build_report`` (the exact path the CLI and
the PDF-container flow use). "Non-silent-pass" means the report is never
``valid=True``; "actionable" means it is a structured report (an ``error`` code
or a fatal rule violation), never a bare traceback / hang / OOM.

  (a) very large but well-formed  -> ``input-too-large`` resource bound
  (b) deeply-nested elements      -> ``max-depth-exceeded`` resource bound
  (c) truncated / garbled XML     -> ``not-well-formed``
  (d) wrong-root / non-invoice    -> fatal ``S-ROOT`` (structural), non-pass
  (e) empty / zero-byte input     -> ``not-well-formed``
  (f) non-UTF-8 / wrong-encoding  -> ``not-well-formed``

The resource ceilings (a)/(b) are enforced in :mod:`einvoice._xmlsec` with
stable error ids and sit orders of magnitude above every legitimate invoice
(the shipped corpus tops out at 3.3 MB, depth 9, ~900 elements), so no real
document's validation output changes — ``differential.py`` (0 divergences) and
``test_golden_snapshot.py`` prove the HARD INVARIANT holds.

Standard library only. Runs offline. Run: python3 test_robustness.py
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice import report as _report                 # noqa: E402
from einvoice import cli as _cli                        # noqa: E402
from einvoice import _xmlsec                            # noqa: E402
from einvoice.parser import NotWellFormed, parse_file as _parse_ubl   # noqa: E402
from einvoice.parser_cii import (                                     # noqa: E402
    NotWellFormed as NotWellFormedCII, parse_file as _parse_cii)

CLI = os.path.join(HERE, "einvoice.py")
BENIGN = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src", "test",
                      "business-cases", "standard", "01.01a-INVOICE_ubl.xml")

UBL_NS = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"

# Every case must finish well inside this wall-clock bound. A real hang / OOM /
# unbounded expansion would blow straight past it; the guards make each case
# effectively instant (the size ceiling is an O(1) length check; depth is
# refused mid-parse).
TIME_BUDGET_S = 8.0


def _write(tmpdir, name, data):
    path = os.path.join(tmpdir, name)
    with open(path, "wb") as fh:
        fh.write(data)
    return path


def _timed_report(data, suffix=".xml"):
    """Run ``build_report`` on ``data`` and return (report, elapsed_seconds)."""
    with tempfile.TemporaryDirectory() as td:
        path = _write(td, "in" + suffix, data)
        t0 = time.time()
        rep = _report.build_report(path, profile="xrechnung")
        elapsed = time.time() - t0
    return rep, elapsed


def _assert_bounded_nonpass(test, rep, elapsed):
    """The shared contract: bounded time, a real report dict, never a PASS."""
    test.assertLess(elapsed, TIME_BUDGET_S,
                    "took %.2fs — possible hang / unbounded work" % elapsed)
    test.assertIsInstance(rep, dict)
    test.assertIn("valid", rep)
    test.assertFalse(rep["valid"],
                     "hostile/malformed input must NOT validate as PASS")


def _assert_error_report(test, rep, elapsed, error="not-well-formed",
                         id_token=None):
    """A report whose actionable signal is an ``error`` code (parse/resource)."""
    _assert_bounded_nonpass(test, rep, elapsed)
    test.assertEqual(rep.get("error"), error,
                     "expected error=%r, got %r" % (error, rep.get("error")))
    # No rule findings fabricated and no expansion leaked into the counts.
    test.assertEqual(rep["violation_count"], 0)
    test.assertEqual(rep["violations"], [])
    # The message stays tiny (no expanded/echoed payload) and carries the
    # stable machine-readable id token when one is expected.
    msg = rep.get("message", "")
    test.assertLess(len(msg), 4096, "error message unexpectedly large")
    if id_token is not None:
        test.assertTrue(msg.startswith(id_token),
                        "message must lead with the stable id %r, got %r"
                        % (id_token, msg[:80]))


class TestLargeWellFormed(unittest.TestCase):
    """(a) A very large but perfectly well-formed document is refused by the
    byte-size ceiling before it can commit unbounded memory."""

    def test_oversized_well_formed_input_bounded(self):
        # One well-formed <Note> body just over the 64 MiB ceiling. This is
        # valid XML with no DTD/entities — only its size is hostile.
        over = _xmlsec.MAX_INPUT_BYTES + 4096
        body = b"x" * over
        data = (('<Invoice xmlns="%s"><Note>' % UBL_NS).encode()
                + body + b"</Note></Invoice>")
        rep, elapsed = _timed_report(data)
        _assert_error_report(self, rep, elapsed,
                             id_token=_xmlsec.ERR_INPUT_TOO_LARGE)
        # The huge body must never be echoed back in the message.
        self.assertNotIn("xxxxxxxxxx", rep.get("message", ""))


class TestDeepNesting(unittest.TestCase):
    """(b) Deep element nesting (no entities) is refused by the depth ceiling
    before the tree is built — no stack overflow / RecursionError / hang."""

    def test_deeply_nested_elements_bounded(self):
        depth = _xmlsec.MAX_ELEMENT_DEPTH + 64
        data = (('<Invoice xmlns="%s">' % UBL_NS).encode()
                + b"<a>" * depth + b"x" + b"</a>" * depth
                + b"</Invoice>")
        rep, elapsed = _timed_report(data)
        _assert_error_report(self, rep, elapsed,
                             id_token=_xmlsec.ERR_MAX_DEPTH)


class TestTruncatedGarbled(unittest.TestCase):
    """(c) Truncated / not-well-formed XML folds into ``not-well-formed``."""

    def test_truncated_xml(self):
        data = ('<Invoice xmlns="%s"><cbc:ID xmlns:cbc="urn:x">12'
                % UBL_NS).encode()  # never closed
        rep, elapsed = _timed_report(data)
        _assert_error_report(self, rep, elapsed)

    def test_garbled_bytes(self):
        # Random binary garbage with an XML-ish prefix.
        data = b"<?xml version='1.0'?><\x00\x01\x02 not xml at all >>>"
        rep, elapsed = _timed_report(data)
        _assert_error_report(self, rep, elapsed)


class TestWrongRoot(unittest.TestCase):
    """(d) A well-formed but non-invoice root (e.g. <html>) is a fatal
    structural failure (S-ROOT), never a silent pass."""

    def test_html_root_is_structural_fatal(self):
        data = (b"<html><head><title>not an invoice</title></head>"
                b"<body><h1>hello</h1></body></html>")
        rep, elapsed = _timed_report(data)
        _assert_bounded_nonpass(self, rep, elapsed)
        # Actionable: a fatal rule violation identifying the wrong root.
        self.assertGreaterEqual(rep["fatal_count"], 1)
        rule_ids = {v.get("rule") for v in rep["violations"]}
        self.assertIn("S-ROOT", rule_ids,
                      "wrong root must surface as the S-ROOT structural fatal, "
                      "got rules %r" % (rule_ids,))

    def test_unrelated_root_is_structural_fatal(self):
        data = (b'<catalog xmlns="urn:example:unrelated">'
                b"<product>widget</product></catalog>")
        rep, elapsed = _timed_report(data)
        _assert_bounded_nonpass(self, rep, elapsed)
        self.assertGreaterEqual(rep["fatal_count"], 1)


class TestEmptyInput(unittest.TestCase):
    """(e) Empty / zero-byte input folds into ``not-well-formed``."""

    def test_zero_byte_input(self):
        rep, elapsed = _timed_report(b"")
        _assert_error_report(self, rep, elapsed)

    def test_whitespace_only_input(self):
        rep, elapsed = _timed_report(b"   \n\t  \n")
        _assert_error_report(self, rep, elapsed)


class TestWrongEncoding(unittest.TestCase):
    """(f) Non-UTF-8 / wrong-encoding bytes fold into ``not-well-formed``."""

    def test_utf16_bom_garbage(self):
        # A UTF-16 BOM followed by bytes that are not valid where UTF-8 is
        # assumed — expat rejects the encoding, no traceback escapes.
        rep, elapsed = _timed_report(b"\xff\xfe<Invoice/>")
        _assert_error_report(self, rep, elapsed)

    def test_latin1_body_declared_utf8(self):
        # A Latin-1 accented byte (0xE9) inside a document declared UTF-8 is
        # an invalid UTF-8 sequence -> not-well-formed, not a decode traceback.
        data = ('<?xml version="1.0" encoding="UTF-8"?>'
                '<Invoice xmlns="%s"><Note>caf\xe9</Note></Invoice>'
                % UBL_NS).encode("latin-1")
        rep, elapsed = _timed_report(data)
        _assert_error_report(self, rep, elapsed)


class TestGuardReachableFromBothParsers(unittest.TestCase):
    """AC2: the size/depth ceilings live in _xmlsec and are reachable from BOTH
    production parse entry points (parser.parse_file and parser_cii.parse_file),
    exactly like the security guard's shared-helper coverage."""

    def _deep(self):
        depth = _xmlsec.MAX_ELEMENT_DEPTH + 64
        return (('<Invoice xmlns="%s">' % UBL_NS).encode()
                + b"<a>" * depth + b"x" + b"</a>" * depth + b"</Invoice>")

    def test_ubl_parser_refuses_deep(self):
        with tempfile.TemporaryDirectory() as td:
            path = _write(td, "deep.xml", self._deep())
            with self.assertRaises(NotWellFormed) as cm:
                _parse_ubl(path)
            self.assertTrue(str(cm.exception).startswith(_xmlsec.ERR_MAX_DEPTH))

    def test_cii_parser_refuses_deep(self):
        with tempfile.TemporaryDirectory() as td:
            path = _write(td, "deep.xml", self._deep())
            with self.assertRaises(NotWellFormedCII) as cm:
                _parse_cii(path)
            self.assertTrue(str(cm.exception).startswith(_xmlsec.ERR_MAX_DEPTH))

    def test_xmlsec_exception_is_parseerror_subclass(self):
        # The bound folds into the ordinary parse-error channel by construction.
        import xml.etree.ElementTree as ET
        self.assertTrue(issubclass(_xmlsec.XMLResourceLimit, ET.ParseError))

    def test_report_bytes_path_refuses_deep(self):
        # The PDF-container byte boundary enforces the same ceiling.
        rep = _report._report_from_invoice_bytes(
            self._deep(), "embedded.xml", "xrechnung")
        self.assertFalse(rep["valid"])
        self.assertEqual(rep.get("error"), "not-well-formed")
        self.assertTrue(rep.get("message", "").startswith(_xmlsec.ERR_MAX_DEPTH))


class TestBoundsDoNotPerturbLegitInput(unittest.TestCase):
    """HARD INVARIANT sanity check: the ceilings sit far above every real
    invoice, so a legitimate document still parses and validates untouched.
    (differential.py + test_golden_snapshot.py are the authoritative proof.)"""

    def test_benign_invoice_unchanged(self):
        self.assertTrue(os.path.isfile(BENIGN), "benign corpus invoice missing")
        rep = _report.build_report(BENIGN, profile="xrechnung")
        self.assertNotIn("error", rep,
                         "legit invoice wrongly flagged by a resource bound")
        self.assertIn("valid", rep)
        self.assertIn("violations", rep)

    def test_just_under_depth_limit_parses(self):
        # A well-formed document nested just BELOW the ceiling must parse fine
        # (proves the bound is an exclusive ceiling, not an off-by-one trap).
        depth = _xmlsec.MAX_ELEMENT_DEPTH - 2
        data = (b"<Invoice>" + b"<a>" * depth + b"x" + b"</a>" * depth
                + b"</Invoice>")
        root = _xmlsec._safe_fromstring(data)  # no raise
        self.assertEqual(root.tag, "Invoice")


class TestCLIActionableExit(unittest.TestCase):
    """A resource-bound payload surfaces through the CLI as the not-well-formed
    exit (3), not a crashing traceback."""

    def test_cli_deep_nesting_exit_code(self):
        depth = _xmlsec.MAX_ELEMENT_DEPTH + 64
        data = (('<Invoice xmlns="%s">' % UBL_NS).encode()
                + b"<a>" * depth + b"x" + b"</a>" * depth + b"</Invoice>")
        with tempfile.TemporaryDirectory() as td:
            path = _write(td, "deep.xml", data)
            proc = subprocess.run(
                [sys.executable, CLI, "validate", path],
                capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, _cli.EXIT_PARSE,
                         "expected not-well-formed exit %d, got %d\nstderr=%s"
                         % (_cli.EXIT_PARSE, proc.returncode, proc.stderr))
        self.assertNotIn("Traceback", proc.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)

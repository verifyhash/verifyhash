#!/usr/bin/env python3
"""test_security.py — untrusted-input XML entity / DTD / XXE hardening.

The einvoice engine parses XML from untrusted suppliers. This suite proves the
DTD/entity/XXE guard added in :mod:`einvoice._xmlsec` and wired into every
production XML entry point (``parser.parse_file``, ``parser_cii.parse_file``,
``report._report_from_invoice_bytes``):

  1. A nested **billion-laughs** entity-expansion payload is REFUSED — no
     expansion, no OOM, bounded time — and surfaces as the engine's actionable
     not-well-formed outcome (report ``error='not-well-formed'`` / CLI exit 3),
     not a traceback and not a silent pass.
  2. A **quadratic-blowup** entity payload is refused the same way.
  3. An **XXE external-entity** payload (``SYSTEM 'file:///etc/passwd'``) does
     NOT read the file (a canary secret never appears in the output) and is
     refused with an actionable error.
  4. An **external-DTD** ``SYSTEM`` reference is refused; and a benign
     well-formed invoice still parses and validates EXACTLY as before.

Everything routes through the shipped public boundaries (``report.build_report``
and the ``einvoice`` CLI) so the assertions are on the real engine output a
caller sees, not on internals.

Standard library only. Runs offline. Run: python3 test_security.py
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

from einvoice import report as _report        # noqa: E402
from einvoice import cli as _cli               # noqa: E402
from einvoice import _xmlsec                   # noqa: E402
from einvoice.parser import NotWellFormed, parse_file as _parse_ubl  # noqa: E402
from einvoice.parser_cii import (                                    # noqa: E402
    NotWellFormed as NotWellFormedCII, parse_file as _parse_cii)

CLI = os.path.join(HERE, "einvoice.py")
BENIGN = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src", "test",
                      "business-cases", "standard", "01.01a-INVOICE_ubl.xml")

# A unique canary that only exists in the local file the XXE payload targets.
# We write the "secret" file ourselves so the test never depends on /etc/passwd
# and can assert the payload does NOT exfiltrate the file contents.
_CANARY = "S3CR3T-CANARY-9f2b-do-not-leak"


# --- malicious payloads ---------------------------------------------------- #

BILLION_LAUGHS = b"""<?xml version="1.0"?>
<!DOCTYPE lolz [
 <!ENTITY lol "lol">
 <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
 <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
 <!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
 <!ENTITY lol5 "&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;">
 <!ENTITY lol6 "&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;">
 <!ENTITY lol7 "&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;">
 <!ENTITY lol8 "&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;">
 <!ENTITY lol9 "&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;">
]>
<lolz>&lol9;</lolz>"""

QUADRATIC_BLOWUP = (b'<?xml version="1.0"?>\n'
                    b'<!DOCTYPE bomb [<!ENTITY a "'
                    + b'A' * 50000 + b'">]>\n'
                    b'<bomb>' + b'&a;' * 5000 + b'</bomb>')


def _xxe_payload(target_path):
    return ('<?xml version="1.0"?>\n'
            '<!DOCTYPE r [ <!ENTITY xxe SYSTEM "file://%s"> ]>\n'
            '<r>&xxe;</r>' % target_path).encode("ascii")


EXTERNAL_DTD = (b'<?xml version="1.0"?>\n'
                b'<!DOCTYPE r SYSTEM "http://198.51.100.1/evil.dtd">\n'
                b'<r>data</r>')


def _write(tmpdir, name, data):
    path = os.path.join(tmpdir, name)
    with open(path, "wb") as fh:
        fh.write(data)
    return path


def _assert_actionable_report(test, rep):
    """A hostile payload must yield a bounded, non-pass, actionable report."""
    test.assertIsInstance(rep, dict)
    test.assertFalse(rep["valid"], "hostile payload must not validate as PASS")
    test.assertEqual(rep.get("error"), "not-well-formed",
                     "hostile payload must fold into the engine's "
                     "not-well-formed error, got %r" % (rep.get("error"),))
    # No rule findings were fabricated and no expansion leaked into counts.
    test.assertEqual(rep["violation_count"], 0)
    test.assertEqual(rep["violations"], [])


class TestNoEntityExpansion(unittest.TestCase):
    def test_billion_laughs_refused_bounded(self):
        with tempfile.TemporaryDirectory() as td:
            path = _write(td, "lol.xml", BILLION_LAUGHS)
            t0 = time.time()
            rep = _report.build_report(path, profile="xrechnung")
            elapsed = time.time() - t0
        _assert_actionable_report(self, rep)
        # A real expansion would take far longer / exhaust memory; the guard
        # aborts at the DOCTYPE, so this is effectively instant.
        self.assertLess(elapsed, 2.0,
                        "billion-laughs took %.2fs — entity expansion may be "
                        "happening" % elapsed)
        # The message must be our controlled refusal, never a giant 'lol' blob.
        self.assertNotIn("lollollol", rep.get("message", ""))

    def test_quadratic_blowup_refused_bounded(self):
        with tempfile.TemporaryDirectory() as td:
            path = _write(td, "quad.xml", QUADRATIC_BLOWUP)
            t0 = time.time()
            rep = _report.build_report(path, profile="xrechnung")
            elapsed = time.time() - t0
        _assert_actionable_report(self, rep)
        self.assertLess(elapsed, 2.0,
                        "quadratic blowup took %.2fs — expansion may be "
                        "happening" % elapsed)
        # 'A' * 50000 * 5000 would be ~250 MB if expanded; the message stays tiny.
        self.assertLess(len(rep.get("message", "")), 4096)
        self.assertNotIn("AAAAAAAAAA", rep.get("message", ""))


class TestNoExternalEntityFileRead(unittest.TestCase):
    def test_xxe_local_file_not_read(self):
        with tempfile.TemporaryDirectory() as td:
            secret = _write(td, "secret.txt", (_CANARY + "\n").encode())
            payload = _xxe_payload(secret)
            path = _write(td, "xxe.xml", payload)
            rep = _report.build_report(path, profile="xrechnung")
        _assert_actionable_report(self, rep)
        # The canary must never appear anywhere in the engine output — proves
        # the external entity was NOT resolved and the file was NOT read.
        self.assertNotIn(_CANARY, str(rep))

    def test_xxe_targeting_etc_passwd_refused(self):
        # The classic /etc/passwd vector — refused before any resolution.
        with tempfile.TemporaryDirectory() as td:
            payload = _xxe_payload("/etc/passwd")
            path = _write(td, "xxe_passwd.xml", payload)
            rep = _report.build_report(path, profile="xrechnung")
        _assert_actionable_report(self, rep)
        self.assertNotIn("root:", str(rep))


class TestNoExternalDTD(unittest.TestCase):
    def test_external_dtd_refused(self):
        with tempfile.TemporaryDirectory() as td:
            path = _write(td, "extdtd.xml", EXTERNAL_DTD)
            t0 = time.time()
            rep = _report.build_report(path, profile="xrechnung")
            elapsed = time.time() - t0
        _assert_actionable_report(self, rep)
        # No network fetch of the external DTD happened (would block/slow).
        self.assertLess(elapsed, 2.0)


class TestBenignInvoiceUnchanged(unittest.TestCase):
    """The guard must not perturb legitimate parsing/validation."""

    def test_benign_invoice_still_parses_and_validates(self):
        self.assertTrue(os.path.isfile(BENIGN), "benign corpus invoice missing")
        rep = _report.build_report(BENIGN, profile="xrechnung")
        # A clean XRechnung standard invoice: no parse error, real report shape.
        self.assertNotIn("error", rep, "benign invoice wrongly flagged: %r"
                         % (rep.get("error"),))
        self.assertIn("valid", rep)
        self.assertIn("violations", rep)

    def test_predefined_entities_still_expand(self):
        # The five XML-predefined entities are legitimate and must still work.
        xml = (b'<Invoice xmlns="urn:oasis:names:specification:ubl:schema:'
               b'xsd:Invoice-2"><note>A &amp; B &lt; C &gt; D</note></Invoice>')
        root = _xmlsec._safe_fromstring(xml)
        note = root[0]
        self.assertEqual(note.text, "A & B < C > D")


class TestSharedHelperUsedEverywhere(unittest.TestCase):
    """AC1: the shared helper is the parse path for all production sites."""

    def test_ubl_parser_refuses_dtd(self):
        with tempfile.TemporaryDirectory() as td:
            path = _write(td, "x.xml", BILLION_LAUGHS)
            with self.assertRaises(NotWellFormed):
                _parse_ubl(path)

    def test_cii_parser_refuses_dtd(self):
        with tempfile.TemporaryDirectory() as td:
            path = _write(td, "x.xml", _xxe_payload("/etc/passwd"))
            with self.assertRaises(NotWellFormedCII):
                _parse_cii(path)

    def test_report_bytes_path_refuses_dtd(self):
        # Directly exercise the PDF-container byte path helper.
        rep = _report._report_from_invoice_bytes(
            BILLION_LAUGHS, "embedded.xml", "xrechnung")
        _assert_actionable_report(self, rep)


class TestCLIActionableExit(unittest.TestCase):
    """The CLI surfaces a hostile payload as the not-well-formed exit (3),
    not a crashing traceback."""

    def test_cli_billion_laughs_exit_code(self):
        with tempfile.TemporaryDirectory() as td:
            path = _write(td, "lol.xml", BILLION_LAUGHS)
            proc = subprocess.run(
                [sys.executable, CLI, "validate", path],
                capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, _cli.EXIT_PARSE,
                         "expected not-well-formed exit %d, got %d\nstderr=%s"
                         % (_cli.EXIT_PARSE, proc.returncode, proc.stderr))
        self.assertNotIn("Traceback", proc.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)

#!/usr/bin/env python3
"""test_network_egress.py — ENFORCE the zero-network-egress guarantee (T-VHAIRGAP.1).

SECURITY.md promises "no network calls — no schema downloads, no telemetry, no
license phone-home … safe to deploy in an air-gapped environment", and ~30
docstrings across the tree say "offline" — but before this suite NOTHING
enforced it: no test monkeypatched the network layer, so a regression that
quietly phoned home (a schema fetch, an external-DTD resolution, a telemetry
POST) would have sailed through every gate. This suite turns the prose claim
into a red/green gate.

HOW: a socket-layer guard (:class:`NetworkEgressGuard`) monkeypatches the
stdlib network primitives — ``socket.create_connection``,
``socket.getaddrinfo``, ``socket.socket.connect`` / ``connect_ex`` /
``sendto``, and ``urllib.request.urlopen`` — to raise a distinctive
:class:`NetworkEgressAttempt` (and RECORD the attempt) on ANY call, before a
single packet leaves the process. ``getaddrinfo`` is included deliberately: a
DNS lookup for a non-numeric host sends UDP to the resolver WITHOUT ever
calling ``connect``, so name resolution is itself a viable egress path.
Patching at the socket layer (not just ``urlopen``) means pre-bound references
deeper in the stack (``http.client``, ``ftplib``, …) are still caught: they
all reach ``socket.create_connection`` / ``connect`` eventually. NO validation
logic is stubbed or mocked — only the network primitives.

What the suite pins:

  1. CANARY SELF-TEST — the guard is provably LIVE: under the guard, real
     connection attempts (``socket.create_connection(('127.0.0.1', 9))``,
     ``urllib.request.urlopen('http://127.0.0.1:9/')``, a raw
     ``socket.socket().connect``, a DNS ``getaddrinfo`` lookup, and an
     ``http.client`` request that only holds pre-bound internals) each raise
     ``NetworkEgressAttempt`` and land in the attempts log. A genuine egress
     attempt therefore FAILS this test — it can never be silently swallowed,
     because even if intermediate code caught the exception, the attempts log
     stays non-empty and the post-run assertion trips.

  2. PIPELINE UNDER GUARD — the REAL end-to-end pipeline (the same
     ``report.build_report`` / ``report.main`` entry points
     ``test_fuzz_input.py`` exercises, plus ``report._report_from_invoice_bytes``,
     the production dispatcher the PDF-container path uses and the only
     report-level entry that routes plain CII bytes through the CII engine)
     runs over representative COMMITTED fixtures with zero egress attempts:
       * valid + invalid UBL (corpus/synthetic);
       * valid + invalid CII (corpus/synthetic, via the CII bytes dispatcher,
         and again via the committed Factur-X PDFs whose embedded invoice is
         CII — the public ``build_report`` route);
       * the XXE-hostile payloads from ``test_security.py`` — the external-DTD
         document referencing ``http://198.51.100.1/evil.dtd`` and the
         ``file://`` external-entity read: the STRONGEST case, since a parser
         that resolved the external reference would trip the guard;
       * the Factur-X PDF-container extractor path (valid + bad committed PDFs).

  3. EQUALITY LEG — for every fixture, the guarded run's full report dict,
     exit code, and CLI stdout are byte-IDENTICAL to an unguarded run in the
     same process: offline-ness changes nothing.

  4. EMITTER SWEEP — every format from ``accepted_formats()`` (the same
     parity-asserted derivation ``test_fuzz_report_formats.py`` uses, read
     live out of report.py so a newly registered format cannot dodge this
     gate) renders under the guard, over both a passing report and a hostile
     not-well-formed report, byte-identical to its unguarded render.

Changes NO parser / rule / report source. Standard library only, zero new
runtime dependency, saxonche-free. The only "network" calls in this file are
the guarded canary attempts against 127.0.0.1:9 (the discard port), which the
guard blocks BEFORE any packet exists. Run: python3 test_network_egress.py
"""

from __future__ import annotations

import contextlib
import http.client
import io
import json
import os
import socket
import sys
import tempfile
import unittest
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# Format list derived from the same source test_report_formats reads — the
# exact parity pattern test_fuzz_report_formats.py uses.
from test_report_formats import accepted_formats  # noqa: E402
# The committed hostile payloads — REUSED from test_security.py so this suite
# drives the very same external-DTD (http://198.51.100.1/evil.dtd) and
# file:// XXE documents that suite proves are refused. No payload duplication.
from test_security import EXTERNAL_DTD, _xxe_payload  # noqa: E402

from einvoice import report as _report_mod  # noqa: E402
from einvoice.report import (  # noqa: E402
    EXIT_OK, EXIT_FAIL, EXIT_PARSE,
    build_report, build_text, build_junit, build_sarif, build_gitlab,
    build_github, build_azure, build_badge, build_html,
)

# ---- committed fixtures (all already in-tree; none added by this task) ---- #
SYNTH = os.path.join(HERE, "corpus", "synthetic")
UBL_VALID = os.path.join(SYNTH, "synth-ubl-good-xrechnung.xml")
UBL_INVALID = os.path.join(SYNTH, "synth-ubl-bad-vat-mismatch.xml")
CII_VALID = os.path.join(SYNTH, "synth-cii-good-multiline.xml")
CII_INVALID = os.path.join(SYNTH, "synth-cii-bad-missing-seller-vat.xml")
PDF_DIR = os.path.join(HERE, "corpus", "pdf")
PDF_VALID = os.path.join(PDF_DIR, "facturx-valid.pdf")   # embedded CII, clean
PDF_BAD = os.path.join(PDF_DIR, "facturx-bad.pdf")       # embedded CII, fatal


class NetworkEgressAttempt(Exception):
    """Raised by the guard on ANY attempted use of a network primitive."""


class NetworkEgressGuard:
    """Context manager that blocks the stdlib network layer.

    While active, every patched primitive raises :class:`NetworkEgressAttempt`
    IMMEDIATELY — the original is never invoked, so no packet (TCP SYN, UDP
    datagram, DNS query) is ever emitted. Each attempt is also appended to
    ``self.attempts``; asserting that list is empty after a pipeline run
    catches even an egress attempt whose exception something swallowed.

    Only network primitives are patched. No validation, parsing, or report
    logic is touched, stubbed, or mocked.
    """

    #: (holder object, attribute name) of every patched primitive.
    #: socket.getaddrinfo is patched because DNS resolution sends UDP to the
    #: resolver WITHOUT going through connect — a real egress path of its own.
    #: sendto covers connectionless UDP; connect/connect_ex cover every TCP
    #: path (http.client, ftplib, smtplib … all bottom out here).
    PRIMITIVES = (
        (socket, "create_connection"),
        (socket, "getaddrinfo"),
        (socket.socket, "connect"),
        (socket.socket, "connect_ex"),
        (socket.socket, "sendto"),
        (urllib.request, "urlopen"),
    )

    def __init__(self):
        self.attempts = []
        self._saved = []

    def _blocker(self, name):
        attempts = self.attempts

        def blocked(*args, **kwargs):
            # Record first, then raise: even if a caller swallows the
            # exception, the attempt stays visible to the post-run assertion.
            attempts.append("%s%r" % (name, args[:2]))
            raise NetworkEgressAttempt(
                "network egress attempted via %s (args=%r) — the einvoice "
                "pipeline promises ZERO network access" % (name, args[:2]))
        return blocked

    def __enter__(self):
        self._saved = [(holder, attr, getattr(holder, attr))
                       for holder, attr in self.PRIMITIVES]
        for holder, attr in self.PRIMITIVES:
            setattr(holder, attr, self._blocker(attr))
        return self

    def __exit__(self, exc_type, exc, tb):
        for holder, attr, original in reversed(self._saved):
            setattr(holder, attr, original)
        self._saved = []
        return False  # never suppress


def _run_main(argv):
    """Drive the real ``einvoice.report.main`` in-process.

    Returns ``(exit_code, stdout_text)`` — the genuine CLI exit path (the same
    error->EXIT_PARSE / fatal->EXIT_FAIL precedence ``python3 -m
    einvoice.report`` ships), captured without spawning a subprocess so the
    guard's monkeypatch stays in effect.
    """
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = _report_mod.main(list(argv))
    return code, buf.getvalue()


def _write_tmp(data):
    """Write ``data`` bytes to a temp .xml file; caller unlinks."""
    fd, path = tempfile.mkstemp(suffix=".xml", prefix="einvoice-egress-")
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    return path


class TestGuardCanary(unittest.TestCase):
    """The guard is live: real egress attempts raise, and are recorded."""

    def test_create_connection_blocked(self):
        with NetworkEgressGuard() as guard:
            with self.assertRaises(NetworkEgressAttempt):
                socket.create_connection(("127.0.0.1", 9))
        self.assertEqual(len(guard.attempts), 1,
                         "create_connection attempt was not recorded")

    def test_urlopen_blocked(self):
        with NetworkEgressGuard() as guard:
            with self.assertRaises(NetworkEgressAttempt):
                urllib.request.urlopen("http://127.0.0.1:9/")
        self.assertGreaterEqual(len(guard.attempts), 1,
                                "urlopen attempt was not recorded")

    def test_raw_socket_connect_blocked(self):
        with NetworkEgressGuard() as guard:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                with self.assertRaises(NetworkEgressAttempt):
                    sock.connect(("127.0.0.1", 9))
            finally:
                sock.close()
        self.assertEqual(len(guard.attempts), 1)

    def test_getaddrinfo_blocked(self):
        # DNS resolution is a real egress path of its own: a lookup for a
        # non-numeric host sends UDP to the resolver without ever calling
        # connect. The guard must block it too.
        with NetworkEgressGuard() as guard:
            with self.assertRaises(NetworkEgressAttempt):
                socket.getaddrinfo("egress-canary.invalid", 80)
        self.assertEqual(len(guard.attempts), 1)

    def test_http_client_layer_blocked(self):
        # http.client holds PRE-BOUND references to socket internals — this
        # proves the socket-layer patch catches deeper stacks, not just code
        # that calls urllib.request.urlopen by name.
        with NetworkEgressGuard() as guard:
            conn = http.client.HTTPConnection("127.0.0.1", 9, timeout=1)
            try:
                with self.assertRaises(NetworkEgressAttempt):
                    conn.request("GET", "/")
            finally:
                conn.close()
        self.assertGreaterEqual(len(guard.attempts), 1)

    def test_guard_restores_primitives_exactly(self):
        originals = [(holder, attr, getattr(holder, attr))
                     for holder, attr in NetworkEgressGuard.PRIMITIVES]
        with NetworkEgressGuard():
            for holder, attr, original in originals:
                self.assertIsNot(
                    getattr(holder, attr), original,
                    "%s.%s was not patched inside the guard" % (holder, attr))
        for holder, attr, original in originals:
            self.assertIs(
                getattr(holder, attr), original,
                "%s.%s was not restored after the guard" % (holder, attr))

    def test_exception_is_distinctive(self):
        # The guard must raise ITS OWN type, not OSError/URLError, so a
        # pipeline component's ordinary error handling cannot mistake an
        # egress attempt for a routine network failure it should retry.
        self.assertTrue(issubclass(NetworkEgressAttempt, Exception))
        self.assertFalse(issubclass(NetworkEgressAttempt, OSError))


class TestPipelineUnderGuard(unittest.TestCase):
    """The real pipeline over committed fixtures: zero egress, identical output."""

    def _assert_guarded_equals_unguarded(self, argv, expect_exit):
        """Run report.main + build_report on ``argv`` twice — unguarded then
        guarded — and assert exit / stdout / report-dict equality and an empty
        attempts log."""
        path = argv[-1]
        # Unguarded reference run (same process).
        code_u, out_u = _run_main(argv)
        rep_u = build_report(path, profile=self._profile_of(argv))
        # Guarded run.
        with NetworkEgressGuard() as guard:
            code_g, out_g = _run_main(argv)
            rep_g = build_report(path, profile=self._profile_of(argv))
        self.assertEqual(
            guard.attempts, [],
            "pipeline attempted network egress on %s" % path)
        self.assertEqual(code_u, expect_exit,
                         "fixture %s no longer produces exit %d — it stopped "
                         "being representative" % (path, expect_exit))
        self.assertEqual(code_g, code_u, "guarded exit differs on %s" % path)
        self.assertEqual(out_g, out_u,
                         "guarded CLI stdout differs on %s" % path)
        self.assertEqual(rep_g, rep_u,
                         "guarded report dict differs on %s" % path)
        return rep_g

    @staticmethod
    def _profile_of(argv):
        return argv[argv.index("--profile") + 1] if "--profile" in argv \
            else "xrechnung"

    def test_valid_ubl_under_guard(self):
        rep = self._assert_guarded_equals_unguarded([UBL_VALID], EXIT_OK)
        self.assertTrue(rep["valid"])

    def test_invalid_ubl_under_guard(self):
        rep = self._assert_guarded_equals_unguarded([UBL_INVALID], EXIT_FAIL)
        self.assertFalse(rep["valid"])
        self.assertGreater(rep["fatal_count"], 0)

    def test_valid_and_invalid_cii_under_guard(self):
        # Plain-CII bytes route through report._report_from_invoice_bytes —
        # the production dispatcher the PDF-container path uses and the only
        # report-level entry that runs the CII engine (parser_cii.build_model
        # + rules.ALL_RULES + rules_xrechnung.evaluate_cii) on raw CII XML.
        for path, expect_valid in ((CII_VALID, True), (CII_INVALID, False)):
            with open(path, "rb") as fh:
                data = fh.read()
            rep_u = _report_mod._report_from_invoice_bytes(
                data, path, "xrechnung")
            with NetworkEgressGuard() as guard:
                rep_g = _report_mod._report_from_invoice_bytes(
                    data, path, "xrechnung")
            self.assertEqual(guard.attempts, [],
                             "CII engine attempted egress on %s" % path)
            self.assertEqual(rep_g, rep_u,
                             "guarded CII report differs on %s" % path)
            self.assertEqual(
                rep_g["valid"], expect_valid,
                "CII fixture %s stopped being representative" % path)

    def test_xxe_hostile_fixtures_under_guard(self):
        # The strongest case: a parser that resolved the external DTD at
        # http://198.51.100.1/evil.dtd (or the file:// entity) would trip the
        # guard. The hardened parser must instead refuse the DTD up front and
        # fold it into the documented not-well-formed / EXIT_PARSE outcome —
        # with ZERO egress attempts.
        payloads = {
            "external-dtd-http-evil.dtd": EXTERNAL_DTD,
            "xxe-file-etc-passwd": _xxe_payload("/etc/passwd"),
        }
        for name, payload in payloads.items():
            path = _write_tmp(payload)
            try:
                rep = self._assert_guarded_equals_unguarded(
                    [path], EXIT_PARSE)
                self.assertFalse(rep["valid"],
                                 "%s must never validate" % name)
                self.assertEqual(rep.get("error"), "not-well-formed",
                                 "%s must fold into the documented "
                                 "not-well-formed report" % name)
            finally:
                os.unlink(path)

    def test_pdf_container_extractor_under_guard(self):
        # The committed Factur-X PDFs exist (test_pdf_container.py drives the
        # same files); assert that explicitly so a future fixture removal
        # surfaces here as a hard failure, never a silent skip.
        self.assertTrue(
            os.path.isfile(PDF_VALID) and os.path.isfile(PDF_BAD),
            "committed PDF fixtures missing (%s / %s) — the PDF-container "
            "egress leg has nothing to run on" % (PDF_VALID, PDF_BAD))
        # The embedded invoice in both PDFs is CII, so this also re-covers the
        # CII engine through the PUBLIC build_report entry point.
        # facturx-valid.pdf is clean under the EN core; facturx-bad.pdf fires
        # its fatals under the xrechnung CIUS layer (the default profile) —
        # profiles chosen so the pair covers BOTH exit outcomes.
        rep = self._assert_guarded_equals_unguarded(
            ["--profile", "en16931", PDF_VALID], EXIT_OK)
        self.assertTrue(rep["valid"])
        rep = self._assert_guarded_equals_unguarded([PDF_BAD], EXIT_FAIL)
        self.assertFalse(rep["valid"])
        self.assertGreater(rep["fatal_count"], 0)


# --------------------------------------------------------------------------- #
# Emitter sweep: fmt -> emitter callable over a report dict. The sarif /
# gitlab / badge builders return Python objects which the shipped CLI
# serialises with json.dumps — mirrored here exactly as in
# test_fuzz_report_formats.py, so the sweep drives the same build+serialise
# pipeline the real --format path runs.
# --------------------------------------------------------------------------- #
EMITTERS = {
    "text": build_text,
    "json": lambda rep: json.dumps(rep, sort_keys=True),
    "junit": build_junit,
    "sarif": lambda rep: json.dumps(build_sarif(rep), sort_keys=True),
    "gitlab": lambda rep: json.dumps(build_gitlab(rep), sort_keys=True),
    "github": build_github,
    "azure": build_azure,
    "badge": lambda rep: json.dumps(build_badge(rep), sort_keys=True),
    "html": build_html,
}


class TestEmitterSweepUnderGuard(unittest.TestCase):
    """Every registered report format renders under the guard, unchanged."""

    def test_emitter_table_matches_accepted_formats(self):
        # Same parity assertion pattern as test_fuzz_report_formats.py: the
        # exercised set is derived live from report.py, so registering a new
        # format without egress coverage here turns this gate red.
        self.assertEqual(
            set(EMITTERS), accepted_formats(),
            "EMITTERS drifted from report.py's registered --format set — a "
            "new format MUST gain egress coverage here (or a removed one "
            "must be dropped)")

    def test_every_format_renders_under_guard(self):
        # Two guarded Results: a clean pass and a hostile not-well-formed
        # error report (the XXE external-DTD document), so both report shapes
        # cross every emitter.
        xxe_path = _write_tmp(EXTERNAL_DTD)
        try:
            reports = {
                "ubl-valid": build_report(UBL_VALID),
                "xxe-error": build_report(xxe_path),
            }
        finally:
            os.unlink(xxe_path)
        for rep_name, rep in reports.items():
            unguarded = {fmt: emit(rep) for fmt, emit in EMITTERS.items()}
            with NetworkEgressGuard() as guard:
                for fmt in sorted(accepted_formats()):
                    with self.subTest(report=rep_name, fmt=fmt):
                        out = EMITTERS[fmt](rep)
                        self.assertIsInstance(out, str)
                        self.assertTrue(
                            out.strip(),
                            "%s emitted empty output under guard" % fmt)
                        self.assertEqual(
                            out, unguarded[fmt],
                            "%s render differs under the guard" % fmt)
            self.assertEqual(
                guard.attempts, [],
                "an emitter attempted network egress on %s" % rep_name)


if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if result.wasSuccessful():
        print("OK: zero-egress guard enforced over the end-to-end pipeline "
              "(%d formats swept)" % len(EMITTERS))
        sys.exit(0)
    sys.exit(1)

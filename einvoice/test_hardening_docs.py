#!/usr/bin/env python3
"""test_hardening_docs.py — DOC-DRIFT GUARD for the enforced hardening claims.

T-VHAIRGAP.2 + T-VHFUZZ.3 (zero-defect close). SECURITY.md and README.md now
publish two mechanical guarantees:

  1. ZERO NETWORK EGRESS — enforced at the socket layer by
     ``test_network_egress.py`` (T-VHAIRGAP.1), which monkeypatches
     ``socket.create_connection``, ``socket.getaddrinfo``,
     ``socket.socket.connect``/``connect_ex``/``sendto`` and
     ``urllib.request.urlopen`` and runs the full pipeline under the guard.
  2. FUZZ TOTALITY, MEASURED — a fixed-seed (0xF0221A7) corpus of 240 mutated
     blobs / 6 strategies through ``report.build_report`` in-process, a
     40-blob deterministic subset through the real ``validate`` subprocess
     boundary, and all 9 registered report formats over all 240 fuzz Results,
     with ZERO crashes/hangs/emitter throws found (``test_fuzz_input.py`` +
     ``test_fuzz_report_formats.py``).

Prose and enforcement can silently diverge in either direction: someone can
delete or gut the guard test while the docs keep promising the guarantee, or
rewrite the docs so they claim something no test proves. This suite pins the
two together:

  * if ``test_network_egress.py`` is removed, or its socket-layer monkeypatch
    strings are gutted, this suite goes RED;
  * if SECURITY.md drops the zero-egress claim, the guard-test reference, or
    the named socket primitive, this suite goes RED;
  * if SECURITY.md drops the measured fuzz-totality paragraph (or the fuzz
    suites it names disappear from disk), this suite goes RED;
  * if README.md drops the "zero network egress" statement or its SECURITY.md
    reference next to it, this suite goes RED.

Stdlib-only, fully offline (it only reads files inside this directory), and
self-running:  ``python3 test_hardening_docs.py``.

It deliberately pins SHORT, load-bearing substrings of the landed wording —
enough that the claim cannot vanish or be inverted without failing, while
leaving room for innocuous copy-editing around them.
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))

SECURITY_MD = os.path.join(HERE, "SECURITY.md")
README_MD = os.path.join(HERE, "README.md")
EGRESS_GUARD = os.path.join(HERE, "test_network_egress.py")
FUZZ_INPUT = os.path.join(HERE, "test_fuzz_input.py")
FUZZ_FORMATS = os.path.join(HERE, "test_fuzz_report_formats.py")


def _read(path):
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


class TestZeroEgressClaimInSecurityMd(unittest.TestCase):
    """SECURITY.md must still make the zero-egress claim AND tie it to the guard."""

    @classmethod
    def setUpClass(cls):
        cls.text = _read(SECURITY_MD)

    def test_offline_claim_text_present(self):
        # Substrings of the landed "Offline / air-gappable" wording. If the
        # section is deleted or rewritten to stop claiming offline operation,
        # these pins fail.
        for needle in (
            "no network calls",
            "air-gapped environment",
            "enforced** guarantee, not prose",
        ):
            self.assertIn(
                needle, self.text,
                "SECURITY.md lost the zero-egress claim text %r" % needle)

    def test_guard_test_referenced_by_name(self):
        self.assertIn(
            "test_network_egress.py", self.text,
            "SECURITY.md no longer references the egress guard test by name")

    def test_monkeypatched_primitives_named(self):
        # The doc must keep naming the concrete socket-layer primitives the
        # guard patches — at minimum socket.create_connection.
        self.assertIn(
            "socket.create_connection", self.text,
            "SECURITY.md no longer names socket.create_connection among the "
            "monkeypatched primitives")
        self.assertIn(
            "socket.getaddrinfo", self.text,
            "SECURITY.md no longer names socket.getaddrinfo among the "
            "monkeypatched primitives")
        self.assertIn(
            "urllib.request.urlopen", self.text,
            "SECURITY.md no longer names urllib.request.urlopen among the "
            "monkeypatched primitives")


class TestEgressGuardStillOnDiskAndArmed(unittest.TestCase):
    """Deleting or gutting test_network_egress.py must turn this suite red."""

    def test_guard_file_exists(self):
        self.assertTrue(
            os.path.isfile(EGRESS_GUARD),
            "%s is missing — the zero-egress guarantee is no longer enforced"
            % EGRESS_GUARD)

    def test_guard_source_still_patches_the_socket_layer(self):
        src = _read(EGRESS_GUARD)
        for needle in ("socket.create_connection", "getaddrinfo", "urlopen"):
            self.assertIn(
                needle, src,
                "test_network_egress.py no longer contains %r — the "
                "socket-layer monkeypatch has been gutted" % needle)


class TestReadmeEgressStatement(unittest.TestCase):
    """README.md must state the enforced claim and point at SECURITY.md near it."""

    @classmethod
    def setUpClass(cls):
        cls.text = _read(README_MD)

    def test_zero_egress_phrase_present(self):
        self.assertIn(
            "zero network egress", self.text,
            "README.md lost the 'zero network egress' statement")

    def test_security_md_referenced_near_the_claim(self):
        idx = self.text.find("zero network egress")
        self.assertNotEqual(idx, -1)
        window = self.text[max(0, idx - 200):idx + 300]
        self.assertIn(
            "SECURITY.md", window,
            "README.md no longer references SECURITY.md near the "
            "'zero network egress' claim")

    def test_claim_names_the_enforcing_test(self):
        idx = self.text.find("zero network egress")
        window = self.text[max(0, idx - 200):idx + 300]
        self.assertIn(
            "test_network_egress.py", window,
            "README.md's egress claim no longer names test_network_egress.py "
            "as the enforcing test")


class TestFuzzTotalityParagraphInSecurityMd(unittest.TestCase):
    """The measured fuzz-totality paragraph (T-VHFUZZ.3) must survive intact."""

    @classmethod
    def setUpClass(cls):
        cls.text = _read(SECURITY_MD)

    def test_paragraph_names_both_fuzz_suites(self):
        for needle in ("test_fuzz_input.py", "test_fuzz_report_formats.py"):
            self.assertIn(
                needle, self.text,
                "SECURITY.md's fuzz-totality paragraph no longer names %r"
                % needle)

    def test_measured_facts_present(self):
        # The load-bearing measured facts: seed, corpus budget, subprocess
        # subset, format sweep, and the zero-defect conclusion.
        for needle in (
            "Fuzz totality",
            "0xF0221A7",
            "240 mutated",
            "40-blob",
            "9 registered report formats",
            "no source fix was required",
        ):
            self.assertIn(
                needle, self.text,
                "SECURITY.md lost the measured fuzz-totality fact %r" % needle)

    def test_both_fuzz_suites_exist_on_disk(self):
        for path in (FUZZ_INPUT, FUZZ_FORMATS):
            self.assertTrue(
                os.path.isfile(path),
                "%s is missing — the fuzz-totality claim in SECURITY.md is no "
                "longer backed by an on-disk test" % path)


if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if result.wasSuccessful():
        print("OK: hardening docs (zero egress + fuzz totality) are pinned to "
              "their enforcing tests")
        sys.exit(0)
    sys.exit(1)

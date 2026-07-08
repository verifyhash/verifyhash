#!/usr/bin/env python3
"""test_receipt.py — prove the conformance-receipt claims for real.

The receipt is verifyhash's tamper-evidence bridge: a canonical, byte-stable
JSON attestation of a validation outcome. This suite asserts the four
properties that make it worth anything:

  (a) DETERMINISM — the same input bytes + profile yield a byte-identical
      receipt and an identical content hash, across repeated in-process calls
      AND across separate CLI process invocations (no wall-clock leaks in).
  (b) HONEST PASS — a known-good corpus invoice gets verdict PASS, and the
      receipt's ``input_sha256`` equals the SHA-256 of the file's raw bytes.
  (c) TAMPER-EVIDENCE — mutating a single byte changes ``input_sha256``; a
      rule-relevant mutation additionally flips the verdict PASS -> FAIL and
      names the newly-failing fatal rule.
  (d) CONTENT HASH = f(body) — the content hash is exactly the SHA-256 of the
      canonicalized body, so it changes iff the body changes (and not
      otherwise).

Standard library only. Fast: no corpus sweep, no subprocess-per-vector — a
handful of validations over one small invoice.
"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice import __version__                                   # noqa: E402
from einvoice.receipt import (                                     # noqa: E402
    build_receipt, receipt_json, canonical_json, TOOL_NAME,
)

WRAPPER = os.path.join(HERE, "einvoice.py")
# A vendored, EN 16931-conformant UBL invoice that PASSES the core profile with
# ZERO violations (verified by conformance.py). Used as the known-good input.
PASS_INVOICE = os.path.join(HERE, "corpus", "vendored", "valid",
                            "cen-bis3-positive_ubl.xml")

# Substrings we mutate. Asserted present at setup so a corpus refresh that moves
# them fails LOUDLY here instead of silently weakening the tamper test.
ID_ELEMENT = b"<cbc:ID>12345</cbc:ID>"
ID_BLANKED = b"<cbc:ID></cbc:ID>"          # -> BR-02: no Invoice number (fatal)
ID_ONE_BYTE = b"<cbc:ID>92345</cbc:ID>"    # 1 byte flipped, still valid + PASS


def _file_bytes(path):
    with open(path, "rb") as fh:
        return fh.read()


def _write_temp(raw):
    fd, path = tempfile.mkstemp(suffix=".xml", prefix="receipt-test-")
    with os.fdopen(fd, "wb") as fh:
        fh.write(raw)
    return path


class ReceiptFixtures(unittest.TestCase):
    def test_pass_invoice_and_mutation_anchors_exist(self):
        """Guard against corpus drift silently disarming the tamper test."""
        self.assertTrue(os.path.isfile(PASS_INVOICE), PASS_INVOICE)
        raw = _file_bytes(PASS_INVOICE)
        self.assertIn(ID_ELEMENT, raw,
                      "fixture drift: PASS invoice lost its <cbc:ID> anchor")


class Determinism(unittest.TestCase):
    """(a) identical input + profile -> byte-identical receipt + content hash."""

    def test_two_api_calls_are_byte_identical(self):
        one = receipt_json(PASS_INVOICE)
        two = receipt_json(PASS_INVOICE)
        self.assertEqual(one, two)
        self.assertEqual(build_receipt(PASS_INVOICE)["content_sha256"],
                         build_receipt(PASS_INVOICE)["content_sha256"])

    def test_two_cli_processes_are_byte_identical(self):
        """Separate OS processes -> identical stdout. If any wall-clock leaked
        into the receipt this would (eventually) fail; by construction it can't."""
        out1 = subprocess.run([sys.executable, WRAPPER, "receipt", PASS_INVOICE],
                              capture_output=True)
        out2 = subprocess.run([sys.executable, WRAPPER, "receipt", PASS_INVOICE],
                              capture_output=True)
        self.assertEqual(out1.returncode, 0, out1.stderr)
        self.assertEqual(out2.returncode, 0, out2.stderr)
        self.assertEqual(out1.stdout, out2.stdout)
        # And the CLI emits exactly the canonical API string + a newline.
        self.assertEqual(out1.stdout.decode("utf-8"),
                         receipt_json(PASS_INVOICE) + "\n")

    def test_cli_receipt_has_all_required_fields(self):
        out = subprocess.run([sys.executable, WRAPPER, "receipt", PASS_INVOICE],
                             capture_output=True)
        doc = json.loads(out.stdout)
        self.assertIn("content_sha256", doc)
        body = doc["receipt"]
        self.assertEqual(body["tool"], {"name": TOOL_NAME, "version": __version__})
        self.assertEqual(body["profile"], "en16931")
        self.assertIn(body["verdict"], ("PASS", "FAIL"))
        self.assertIn("input_sha256", body)
        self.assertIn("failed_fatal_rules", body)


class HonestPass(unittest.TestCase):
    """(b) known-good invoice -> PASS, and input hash == sha256(file bytes)."""

    def test_pass_verdict_and_input_hash_matches_file_bytes(self):
        receipt = build_receipt(PASS_INVOICE)["receipt"]
        self.assertEqual(receipt["verdict"], "PASS")
        self.assertTrue(receipt["well_formed"])
        self.assertEqual(receipt["failed_fatal_rules"], [])
        expected = hashlib.sha256(_file_bytes(PASS_INVOICE)).hexdigest()
        self.assertEqual(receipt["input_sha256"], expected)

    def test_version_comes_from_single_source_of_truth(self):
        # Not a second hardcoded copy: it is exactly einvoice.__version__.
        receipt = build_receipt(PASS_INVOICE)["receipt"]
        self.assertEqual(receipt["tool"]["version"], __version__)


class TamperEvidence(unittest.TestCase):
    """(c) one byte -> input hash changes; rule-relevant edit -> verdict flips."""

    def test_single_byte_flip_changes_input_hash(self):
        base = build_receipt(PASS_INVOICE)["receipt"]
        raw = _file_bytes(PASS_INVOICE)
        mutated = raw.replace(ID_ELEMENT, ID_ONE_BYTE, 1)
        self.assertEqual(len(mutated), len(raw), "must be a same-length 1-byte flip")
        self.assertNotEqual(mutated, raw)
        path = _write_temp(mutated)
        try:
            after = build_receipt(path)["receipt"]
        finally:
            os.remove(path)
        self.assertNotEqual(after["input_sha256"], base["input_sha256"])
        # A rule-neutral byte flip still validates: tamper of the *bytes* is
        # detectable even when the invoice remains conformant.
        self.assertEqual(after["verdict"], "PASS")

    def test_rule_relevant_mutation_flips_verdict_and_hashes(self):
        base = build_receipt(PASS_INVOICE)
        self.assertEqual(base["receipt"]["verdict"], "PASS")
        raw = _file_bytes(PASS_INVOICE)
        mutated = raw.replace(ID_ELEMENT, ID_BLANKED, 1)
        self.assertNotEqual(mutated, raw)
        path = _write_temp(mutated)
        try:
            after = build_receipt(path)
        finally:
            os.remove(path)
        self.assertEqual(after["receipt"]["verdict"], "FAIL")
        self.assertNotEqual(after["receipt"]["input_sha256"],
                            base["receipt"]["input_sha256"])
        self.assertNotEqual(after["content_sha256"], base["content_sha256"])
        failed_ids = [r["rule"] for r in after["receipt"]["failed_fatal_rules"]]
        self.assertIn("BR-02", failed_ids)          # missing Invoice number
        # Each failed entry carries its human message (sourced via to_dict()).
        self.assertTrue(all(r.get("message") for r in
                            after["receipt"]["failed_fatal_rules"]))


class ContentHashIsFunctionOfBody(unittest.TestCase):
    """(d) content hash == sha256(canonical(body)); changes iff body changes."""

    def test_content_hash_equals_sha256_of_canonical_body(self):
        doc = build_receipt(PASS_INVOICE)
        recomputed = hashlib.sha256(
            canonical_json(doc["receipt"]).encode("utf-8")).hexdigest()
        self.assertEqual(doc["content_sha256"], recomputed)

    def test_identical_body_same_hash_changed_body_new_hash(self):
        # Same body -> same hash.
        a = build_receipt(PASS_INVOICE)
        b = build_receipt(PASS_INVOICE)
        self.assertEqual(a["receipt"], b["receipt"])
        self.assertEqual(a["content_sha256"], b["content_sha256"])

        # Body genuinely changes (explicit issued_at) -> hash MUST change.
        stamped = build_receipt(PASS_INVOICE, issued_at="2026-01-01T00:00:00Z")
        self.assertNotEqual(stamped["receipt"], a["receipt"])
        self.assertNotEqual(stamped["content_sha256"], a["content_sha256"])
        self.assertEqual(
            stamped["content_sha256"],
            hashlib.sha256(canonical_json(stamped["receipt"]).encode("utf-8")).hexdigest())

        # A different explicit timestamp -> different body -> different hash.
        stamped2 = build_receipt(PASS_INVOICE, issued_at="2026-01-02T00:00:00Z")
        self.assertNotEqual(stamped2["content_sha256"], stamped["content_sha256"])

    def test_no_timestamp_by_default(self):
        # Determinism guarantee: no wall-clock unless explicitly provided.
        self.assertNotIn("issued_at", build_receipt(PASS_INVOICE)["receipt"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

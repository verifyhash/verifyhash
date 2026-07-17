#!/usr/bin/env python3
"""test_receipt_recipe.py — the executable counterpart of RECEIPT-VERIFICATION.md.

RECEIPT-VERIFICATION.md documents, in prose plus a worked Python snippet, the
ONLY integrity check a conformance receipt supports: there is no
``verify-receipt`` subcommand — the check is a stdlib recompute-and-compare that
any consumer can run with just ``hashlib`` + ``json``. The doc states it as:

    canonical_json(body) = json.dumps(body, sort_keys=True, separators=(",", ":"))
    recompute            = sha256(canonical_json(doc["receipt"])).hexdigest()
    intact               = (recompute == doc["content_sha256"])

This test is a DRIFT GUARD binding that documented recipe to reality. It
transcribes the doc's snippet verbatim (stdlib only, NO einvoice import for the
verify step — mirroring "no einvoice install needed"), runs it over EVERY
committed golden receipt fixture, and asserts:

  * each golden receipt verifies CLEAN under the documented check, and
  * a single-field mutation of a receipt body is REJECTED by it.

It also asserts RECEIPT-VERIFICATION.md still SAYS what this test DOES (the doc
carries the exact ``sort_keys=True`` / ``separators`` / ``content_sha256``
recipe), so if the doc and this guard ever diverge the guard fails loudly. The
fix for such a divergence is to correct the DOC to match ``receipt.py`` — never
to loosen the tool. No package code is touched.

Distinct from test_receipt_tamper.py: that suite proves totality over receipts
freshly built by ``build_receipt``; THIS suite pins the check to the COMMITTED
``golden/receipt-*.json`` fixtures and to the doc's stated command, so a drift
in either the stored fixtures or the documented recipe is caught. Standard
library only; runnable directly as ``python3 test_receipt_recipe.py``.
"""

import copy
import glob
import hashlib
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DOC_NAME = "RECEIPT-VERIFICATION.md"
DOC_PATH = os.path.join(HERE, DOC_NAME)
GOLDEN_DIR = os.path.join(HERE, "golden")

# The golden receipt fixtures this guard is known to cover. Discovery is by glob
# (so a newly committed receipt fixture is automatically guarded), but these
# must always be present — a disappearing fixture would silently shrink coverage.
EXPECTED_FIXTURES = {
    "receipt-cii-valid-example5.json",
    "receipt-ubl-valid-xr-01.01a.json",
    "receipt-cii-invalid-vat-mismatch.json",
    "receipt-ubl-invalid-creditnote-typecode.json",
    "receipt-cii-creditnote-381.json",
}


# --------------------------------------------------------------------------
# The consumer's check, transcribed VERBATIM from RECEIPT-VERIFICATION.md's
# worked example. Standard library only (hashlib + json); it deliberately does
# NOT import einvoice.receipt — the doc's whole point is that a third party with
# no einvoice install can run this. If this ever needs to change to keep the
# golden fixtures passing, the DOC has drifted from receipt.py and the doc is
# what must be fixed.
# --------------------------------------------------------------------------
def canonical_json(body):
    """canonical_json(body) exactly as the doc states it."""
    return json.dumps(body, sort_keys=True, separators=(",", ":"))


def verify_recompute(doc):
    """intact = (recompute == doc["content_sha256"]); the whole verification.

    A malformed document (missing either half) is treated as NOT intact rather
    than raising, so callers can feed arbitrary JSON."""
    try:
        body = doc["receipt"]
        stored = doc["content_sha256"]
    except (KeyError, TypeError):
        return False
    recompute = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    return recompute == stored


def _golden_receipt_paths():
    return sorted(glob.glob(os.path.join(GOLDEN_DIR, "receipt-*.json")))


class DocBinding(unittest.TestCase):
    """The guard is discoverably the doc's executable counterpart."""

    def test_doc_exists_and_states_the_recipe_this_test_runs(self):
        self.assertTrue(os.path.isfile(DOC_PATH),
                        "%s must exist — this test is its executable guard"
                        % DOC_NAME)
        with open(DOC_PATH, encoding="utf-8") as fh:
            text = fh.read()
        # The exact recipe elements this test transcribes must still be in the
        # doc; if the doc drops or changes them, doc and guard have diverged.
        for token in ('sort_keys=True', 'separators=(",", ":")',
                      'content_sha256', 'sha256'):
            self.assertIn(token, text,
                          "%s no longer documents %r — doc/guard drift"
                          % (DOC_NAME, token))


class GoldenReceiptsVerifyClean(unittest.TestCase):
    """Every committed golden receipt passes the documented check."""

    def test_all_expected_fixtures_present(self):
        found = {os.path.basename(p) for p in _golden_receipt_paths()}
        missing = EXPECTED_FIXTURES - found
        self.assertEqual(missing, set(),
                         "committed golden receipt fixtures missing: %s"
                         % sorted(missing))

    def test_every_golden_receipt_verifies_clean(self):
        paths = _golden_receipt_paths()
        self.assertTrue(paths, "no golden/receipt-*.json fixtures found")
        for path in paths:
            with open(path, encoding="utf-8") as fh:
                doc = json.load(fh)
            self.assertTrue(
                verify_recompute(doc),
                "%s: recompute (%r) must equal stored content_sha256 (%r) per "
                "%s" % (os.path.basename(path),
                        hashlib.sha256(
                            canonical_json(doc["receipt"]).encode("utf-8")
                        ).hexdigest(),
                        doc.get("content_sha256"), DOC_NAME))


class MutatedReceiptIsRejected(unittest.TestCase):
    """A single-field mutation of a receipt body is caught by the check."""

    def test_flipping_verdict_is_rejected(self):
        for path in _golden_receipt_paths():
            with open(path, encoding="utf-8") as fh:
                doc = json.load(fh)
            stored = doc["content_sha256"]
            body = copy.deepcopy(doc["receipt"])
            # Single-field mutation exactly as the doc names ("flip verdict").
            body["verdict"] = "FAIL" if body.get("verdict") == "PASS" else "PASS"
            self.assertNotEqual(
                body, doc["receipt"],
                "%s: verdict flip did not change the body" % os.path.basename(path))
            tampered = {"receipt": body, "content_sha256": stored}
            self.assertFalse(
                verify_recompute(tampered),
                "%s: a verdict-flipped body must be REJECTED by the documented "
                "recompute-and-compare check" % os.path.basename(path))

    def test_editing_input_sha256_is_rejected(self):
        # A second, distinct single-field mutation the doc names ("edit
        # input_sha256"), to show the guard is not verdict-specific.
        for path in _golden_receipt_paths():
            with open(path, encoding="utf-8") as fh:
                doc = json.load(fh)
            stored = doc["content_sha256"]
            body = copy.deepcopy(doc["receipt"])
            h = body["input_sha256"]
            body["input_sha256"] = ("1" if h[0] != "1" else "2") + h[1:]
            self.assertNotEqual(body, doc["receipt"])
            tampered = {"receipt": body, "content_sha256": stored}
            self.assertFalse(
                verify_recompute(tampered),
                "%s: an edited input_sha256 must be REJECTED" % os.path.basename(path))


if __name__ == "__main__":
    unittest.main(verbosity=2)

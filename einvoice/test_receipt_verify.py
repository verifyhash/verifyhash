#!/usr/bin/env python3
"""test_receipt_verify.py — prove the ``einvoice receipt --verify`` subcommand.

This is the driver-level companion to ``test_receipt_tamper.py``. That suite
proves recompute-and-compare rejects every mutated body *at the library level*
(the consumer's independent re-implementation). THIS suite proves the SAME
guarantee is delivered by the FIRST-CLASS CLI subcommand — i.e. a user who runs

    einvoice receipt --verify <receipt.json>

gets VERIFIED / exit 0 on an honest receipt and a non-zero rejection on every
tamper class, driving the REAL CLI entry point (``einvoice.py`` as a subprocess),
never an internal helper.

Contract under test (documented in EXIT-CODES.md / RECEIPT-VERIFICATION.md):

  * exit 0 + ``VERIFIED`` on stdout    — recomputed hash == stored hash.
  * exit 1 + ``TAMPERED`` on stdout    — recomputed hash != stored hash
    (any body field altered, OR ``content_sha256`` itself corrupted).
  * exit 2 + ``error:`` on stderr, no  — the file is not a readable receipt:
    traceback                            non-JSON / garbage / truncated, valid
                                         JSON that is not a receipt, or a
                                         nonexistent path.

The tamper classes mirror T-VHRECV.1's table exactly: flipped verdict, edited
input (invoice) hash, dropped failed-rule entry, altered ``tool.version``, and a
corrupted ``content_sha256`` self-hash.

Standard library only. Golden receipts are built in-process via ``build_receipt``
over committed fixtures (the same fixtures ``test_receipt_tamper.py`` uses), then
written to a temp file and checked through the CLI.
"""

import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.receipt import build_receipt                            # noqa: E402

WRAPPER = os.path.join(HERE, "einvoice.py")

# The same committed fixtures test_receipt_tamper.py builds its golden receipts
# from: a PASS invoice (empty failed_fatal_rules) and a FAIL creditnote (>=1
# fatal entry, so the drop-entry tamper class actually applies).
PASS_FIXTURE = os.path.join(HERE, "corpus/vendored/valid/cen-bis3-positive_ubl.xml")
FAIL_FIXTURE = os.path.join(HERE, "fixtures/creditnote-invalid-typecode_ubl.xml")


def _run_verify(receipt_path):
    """Drive the REAL CLI: ``einvoice receipt --verify <receipt_path>``.

    Returns the CompletedProcess (text-decoded stdout/stderr)."""
    return subprocess.run(
        [sys.executable, WRAPPER, "receipt", "--verify", receipt_path],
        capture_output=True, text=True)


def _run_verify_json(receipt_path):
    """Drive the REAL CLI with the machine flag: ``receipt --verify --json``."""
    return subprocess.run(
        [sys.executable, WRAPPER, "receipt", "--verify", "--json", receipt_path],
        capture_output=True, text=True)


def _write_doc(doc):
    """Serialize a receipt document to a temp .json file; return its path."""
    fd, path = tempfile.mkstemp(suffix=".json", prefix="receipt-verify-test-")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(doc, fh)
    return path


def _write_bytes(data):
    fd, path = tempfile.mkstemp(suffix=".json", prefix="receipt-verify-test-")
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    return path


class Fixtures(unittest.TestCase):
    """Guard against fixture drift silently disarming the tamper cases."""

    def test_fixtures_exist(self):
        self.assertTrue(os.path.isfile(PASS_FIXTURE), PASS_FIXTURE)
        self.assertTrue(os.path.isfile(FAIL_FIXTURE), FAIL_FIXTURE)

    def test_fail_fixture_carries_a_fatal_entry(self):
        # The drop-entry tamper class needs a non-empty failed_fatal_rules.
        body = build_receipt(FAIL_FIXTURE)["receipt"]
        self.assertEqual(body["verdict"], "FAIL")
        self.assertTrue(body["failed_fatal_rules"],
                        "FAIL fixture must carry >=1 fatal entry")


class UntamperedVerifiesClean(unittest.TestCase):
    """(a) An honest golden receipt: exit 0 + VERIFIED on stdout."""

    def test_pass_receipt_verifies_clean(self):
        path = _write_doc(build_receipt(PASS_FIXTURE))
        try:
            proc = _run_verify(path)
        finally:
            os.remove(path)
        self.assertEqual(proc.returncode, 0,
                         "clean receipt must verify (stderr: %s)" % proc.stderr)
        self.assertIn("VERIFIED", proc.stdout)
        # A clean verify is stderr-silent.
        self.assertEqual(proc.stderr, "")

    def test_stamped_receipt_verifies_clean(self):
        # A receipt carrying an explicit issued_at still round-trips clean.
        doc = build_receipt(PASS_FIXTURE, issued_at="2026-01-01T00:00:00Z")
        path = _write_doc(doc)
        try:
            proc = _run_verify(path)
        finally:
            os.remove(path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("VERIFIED", proc.stdout)

    def test_reserialized_body_still_verifies(self):
        # A consumer that parsed then re-serialized the body (whitespace/key
        # order differences in the on-disk file) must NOT be mistaken for
        # tampering — the check canonicalizes before hashing.
        doc = build_receipt(PASS_FIXTURE)
        # Write with indentation + a leading unsorted dict to prove the on-disk
        # byte layout is irrelevant; only the canonical body matters.
        fd, path = tempfile.mkstemp(suffix=".json", prefix="receipt-verify-test-")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=4, sort_keys=False)
        try:
            proc = _run_verify(path)
        finally:
            os.remove(path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("VERIFIED", proc.stdout)


# --------------------------------------------------------------------------
# The tamper classes from T-VHRECV.1, each applied to a golden receipt and
# checked THROUGH THE SUBCOMMAND. Every one must be rejected with exit 1 +
# TAMPERED on stdout.
# --------------------------------------------------------------------------
def _flip_verdict(doc):
    b = doc["receipt"]
    b["verdict"] = "FAIL" if b["verdict"] == "PASS" else "PASS"
    return doc


def _edit_input_hash(doc):
    h = doc["receipt"]["input_sha256"]
    first = "1" if h[0] != "1" else "2"
    doc["receipt"]["input_sha256"] = first + h[1:]
    return doc


def _drop_failed_rule(doc):
    doc["receipt"]["failed_fatal_rules"] = doc["receipt"]["failed_fatal_rules"][1:]
    return doc


def _alter_tool_version(doc):
    doc["receipt"]["tool"]["version"] = doc["receipt"]["tool"]["version"] + ".tampered"
    return doc


def _corrupt_content_sha256(doc):
    good = doc["content_sha256"]
    doc["content_sha256"] = ("0" + good[1:]) if good[0] != "0" else ("1" + good[1:])
    return doc


class EveryTamperClassIsRejected(unittest.TestCase):
    """(b) Each T-VHRECV.1 tamper class -> exit 1 + TAMPERED via the subcommand."""

    def _assert_rejected(self, base_fixture, mutate, label, **build_kw):
        doc = build_receipt(base_fixture, **build_kw)
        mutated = mutate(copy.deepcopy(doc))
        self.assertNotEqual(mutated, doc,
                            "%s: mutator did not change the document" % label)
        path = _write_doc(mutated)
        try:
            proc = _run_verify(path)
        finally:
            os.remove(path)
        self.assertEqual(proc.returncode, 1,
                         "%s must be rejected with exit 1 (got %d; stderr %s)"
                         % (label, proc.returncode, proc.stderr))
        self.assertIn("TAMPERED", proc.stdout,
                      "%s must print TAMPERED" % label)

    def test_flipped_verdict_rejected(self):
        self._assert_rejected(PASS_FIXTURE, _flip_verdict, "flip_verdict")

    def test_edited_invoice_hash_rejected(self):
        self._assert_rejected(PASS_FIXTURE, _edit_input_hash, "edit_input_sha256")

    def test_dropped_failed_rule_rejected(self):
        # Needs the FAIL fixture (a non-empty failed_fatal_rules list).
        self._assert_rejected(FAIL_FIXTURE, _drop_failed_rule, "drop_failed_rule")

    def test_altered_tool_version_rejected(self):
        self._assert_rejected(PASS_FIXTURE, _alter_tool_version, "alter_tool_version")

    def test_corrupted_content_sha256_rejected(self):
        # The outer self-hash corrupted alone: body intact, stored value wrong.
        self._assert_rejected(PASS_FIXTURE, _corrupt_content_sha256,
                              "corrupt_content_sha256")


class MalformedFilesError(unittest.TestCase):
    """(c) Non-JSON / garbage / truncated / nonexistent -> exit 2, no traceback."""

    def _assert_usage_error(self, path, label, cleanup=True):
        proc = _run_verify(path)
        try:
            self.assertEqual(proc.returncode, 2,
                             "%s must exit 2 (got %d)" % (label, proc.returncode))
            self.assertIn("error:", proc.stderr,
                          "%s must print an actionable error line" % label)
            # A traceback would leak a "Traceback (most recent call last)" banner.
            self.assertNotIn("Traceback", proc.stderr,
                             "%s must NOT print a Python traceback" % label)
            self.assertNotIn("Traceback", proc.stdout)
        finally:
            if cleanup and os.path.exists(path):
                os.remove(path)

    def test_garbage_non_json_errors(self):
        path = _write_bytes(b"this is not json at all {{{")
        self._assert_usage_error(path, "garbage")

    def test_truncated_json_errors(self):
        # A receipt document truncated mid-way through — valid JSON prefix,
        # unparseable as a whole.
        doc = build_receipt(PASS_FIXTURE)
        text = json.dumps(doc)
        path = _write_bytes(text[: len(text) // 2].encode("utf-8"))
        self._assert_usage_error(path, "truncated")

    def test_empty_file_errors(self):
        path = _write_bytes(b"")
        self._assert_usage_error(path, "empty")

    def test_valid_json_but_not_a_receipt_errors(self):
        # Parses as JSON, but lacks the receipt/content_sha256 fields.
        path = _write_bytes(b'{"hello": "world"}')
        self._assert_usage_error(path, "not-a-receipt")

    def test_nonexistent_path_errors(self):
        path = os.path.join(tempfile.gettempdir(), "no-such-receipt-xyz-12345.json")
        self.assertFalse(os.path.exists(path))
        self._assert_usage_error(path, "nonexistent", cleanup=False)


class JsonMachineShape(unittest.TestCase):
    """--json emits exactly one sorted-keys object mirroring the code path,
    with the exit code unchanged. Usage-error legs emit NO JSON body."""

    def _parse_single_object(self, stdout):
        # Exactly one JSON object on stdout — json.loads rejects trailing text,
        # so this also proves nothing else was printed alongside it.
        stripped = stdout.strip()
        self.assertTrue(stripped, "expected a JSON object on stdout, got empty")
        obj = json.loads(stripped)
        self.assertIsInstance(obj, dict)
        # sort_keys=True means the serialized keys are in ascending order.
        self.assertEqual(list(obj.keys()), sorted(obj.keys()),
                         "object must be emitted with sort_keys=True")
        return obj

    def test_clean_receipt_json_shape(self):
        path = _write_doc(build_receipt(PASS_FIXTURE))
        try:
            proc = _run_verify_json(path)
        finally:
            os.remove(path)
        self.assertEqual(proc.returncode, 0,
                         "clean receipt must exit 0 (stderr: %s)" % proc.stderr)
        self.assertEqual(proc.stderr, "")
        obj = self._parse_single_object(proc.stdout)
        self.assertEqual(obj["verdict"], "VERIFIED")
        self.assertIs(obj["match"], True)
        self.assertEqual(obj["recomputed"], obj["stored"])
        # No human line leaked into the machine output.
        self.assertNotIn("VERIFIED:", proc.stdout)

    def test_tampered_receipt_json_shape(self):
        doc = _flip_verdict(build_receipt(PASS_FIXTURE))
        path = _write_doc(doc)
        try:
            proc = _run_verify_json(path)
        finally:
            os.remove(path)
        self.assertEqual(proc.returncode, 1,
                         "tampered receipt must exit 1 (stderr: %s)" % proc.stderr)
        obj = self._parse_single_object(proc.stdout)
        self.assertEqual(obj["verdict"], "TAMPERED")
        self.assertIs(obj["match"], False)
        self.assertNotEqual(obj["recomputed"], obj["stored"])

    def test_garbage_json_emits_no_object(self):
        path = _write_bytes(b"this is not json at all {{{")
        try:
            proc = _run_verify_json(path)
        finally:
            os.remove(path)
        self.assertEqual(proc.returncode, 2,
                         "garbage must exit 2 (got %d)" % proc.returncode)
        self.assertIn("error:", proc.stderr)
        self.assertNotIn("Traceback", proc.stderr)
        # A usage-error leg emits NO JSON body on stdout, exactly like the other
        # subcommands — stdout stays empty even under --json.
        self.assertEqual(proc.stdout.strip(), "")

    def test_not_a_receipt_json_emits_no_object(self):
        path = _write_bytes(b'{"hello": "world"}')
        try:
            proc = _run_verify_json(path)
        finally:
            os.remove(path)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("error:", proc.stderr)
        self.assertEqual(proc.stdout.strip(), "")


class MisuseIsAUsageError(unittest.TestCase):
    """--verify only applies to the receipt subcommand."""

    def test_verify_on_validate_is_usage_error(self):
        path = _write_doc(build_receipt(PASS_FIXTURE))
        try:
            proc = subprocess.run(
                [sys.executable, WRAPPER, "validate", "--verify", path],
                capture_output=True, text=True)
        finally:
            os.remove(path)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertIn("--verify is only valid for the receipt subcommand",
                      proc.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)

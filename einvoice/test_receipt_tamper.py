#!/usr/bin/env python3
"""test_receipt_tamper.py — adversarial totality proof of the receipt's
recompute-and-compare tamper check.

WHAT THE RECEIPT'S INTEGRITY CHECK ACTUALLY IS
----------------------------------------------
There is NO ``verify-receipt`` CLI subcommand, and this suite does not invent
one. A conformance receipt is ``{"receipt": <body>, "content_sha256": <hex>}``
where ``content_sha256`` is the SHA-256 of ``canonical_json(body)`` — the body
serialized with sorted keys and no insignificant whitespace
(``json.dumps(..., sort_keys=True, separators=(",", ":"))``, UTF-8 encoded).

The consumer's integrity check IS therefore, in full:

    recompute = sha256(canonical_json(doc["receipt"])).hexdigest()
    intact    = (recompute == doc["content_sha256"])

Any party with a SHA-256 implementation and a JSON canonicalizer (sorted keys,
compact separators) can run it — no einvoice install, no network, no trust in
whoever produced the receipt. ``verify_recompute`` below is exactly that check,
re-implemented from scratch in the TEST (it does not import build_receipt's
hashing) so the assertions bind the CONSUMER'S view, not the producer's.

WHAT THIS SUITE PROVES (totality, not a handful of examples)
------------------------------------------------------------
(a) UNTAMPERED VERIFIES CLEAN. Every base receipt built by ``build_receipt``
    over a committed fixture recompute-verifies (recomputed == stored), and a
    byte-identical re-serialization of its body still verifies — so the check
    is not trivially always-reject.

(b) EVERY FIELD / STRUCTURAL REGION, MUTATED, IS REJECTED. A TABLE of mutators
    (not ad-hoc one-offs) touches each region of the body — ``verdict``,
    ``input_sha256``, every ``failed_fatal_rules`` sub-field (drop an entry,
    alter its rule id, alter its message, append a fabricated entry),
    ``tool.version``, ``tool.name``, ``profile``, ``well_formed``, ``format``,
    and ``issued_at`` (add when absent, remove when present, alter its value).
    For every applicable (base receipt, mutator) pair we assert BOTH that the
    mutator genuinely changed the body AND that the consumer check rejects it
    (recomputed != stored). Coverage is enforced: the table must collectively
    exercise every documented region, and every mutation must reject.

(c) CORRUPTING content_sha256 ITSELF IS CAUGHT — with the honest nuance stated.
    ``content_sha256`` is a digest of the BODY only; the outer field is NOT part
    of its own hashed pre-image (it does not self-cover). Corrupting the outer
    field ALONE is nonetheless caught, because the comparison TARGET is that
    very field: the body is untouched, so ``recompute`` still equals the
    receipt's true hash, which no longer equals the corrupted stored value ->
    reject. The ONE tamper a single self-contained document cannot catch is a
    COORDINATED body+hash rewrite (mutate the body AND set ``content_sha256`` to
    its correct recompute): that yields an internally consistent but forged
    receipt that recompute-verifies clean. We assert that limit explicitly and
    honestly — it is the defining property of a self-contained digest, NOT a
    defect. Real tamper-evidence closes it by comparing ``content_sha256``
    against an INDEPENDENTLY held / anchored value, or by reproducing the body
    (re-running validation on the original input), neither of which lives inside
    the receipt.

No behaviour change is made to receipt.py: mutating any body field already
changes ``canonical_json(body)`` and hence the recomputed hash, so no gap was
found and nothing needed fixing. Standard library only; runnable directly as
``python3 test_receipt_tamper.py``.
"""

import copy
import hashlib
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.receipt import build_receipt                            # noqa: E402


# --------------------------------------------------------------------------
# The CONSUMER verification, re-implemented from scratch in the test.
# Deliberately does NOT import receipt._sha256_hex / canonical_json for the
# hashing so the assertion binds a third party's independent view: SHA-256 over
# canonical (sorted-key, compact-separator) JSON of the body, compared to the
# stored outer hash. This is the whole integrity contract — there is no CLI
# "verify-receipt"; recompute-and-compare IS the verification.
# --------------------------------------------------------------------------
def _consumer_canonical_json(obj):
    """Canonical JSON a consumer would produce: keys sorted, no insignificant
    whitespace. Independent of receipt.canonical_json (same contract)."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def verify_recompute(doc):
    """The consumer's integrity check: True iff SHA-256 of the canonical body
    equals the receipt's stored ``content_sha256``. A malformed document
    (missing either half) is treated as NOT intact."""
    try:
        body = doc["receipt"]
        stored = doc["content_sha256"]
    except (KeyError, TypeError):
        return False
    recomputed = hashlib.sha256(
        _consumer_canonical_json(body).encode("utf-8")).hexdigest()
    return recomputed == stored


# --------------------------------------------------------------------------
# Base golden receipts, built via build_receipt over COMMITTED fixtures. We use
# three shapes so every region is reachable:
#   * PASS   — verdict PASS, failed_fatal_rules EMPTY (add-entry / flip mutators)
#   * FAIL   — verdict FAIL, exactly one BR-CL-01 fatal (drop / alter-entry
#              mutators need a non-empty list)
#   * STAMPED— the PASS receipt built WITH an explicit issued_at (remove / alter
#              issued_at mutators need the field present)
# --------------------------------------------------------------------------
PASS_FIXTURE = ("corpus/vendored/valid/cen-bis3-positive_ubl.xml", "en16931")
FAIL_FIXTURE = ("fixtures/creditnote-invalid-typecode_ubl.xml", "en16931")
STAMP = "2026-01-01T00:00:00Z"


def _build(rel_path, profile, issued_at=None):
    return build_receipt(os.path.join(HERE, rel_path), profile=profile,
                         issued_at=issued_at)


class _Skip(Exception):
    """Raised by a mutator that does not apply to a given base body."""


# --------------------------------------------------------------------------
# The mutator table. Each entry: (name, region, fn). ``fn`` receives a DEEP COPY
# of the body and returns the mutated body (or raises _Skip if inapplicable to
# that base receipt). ``region`` groups mutators so the coverage guard can prove
# every documented field/region is exercised by at least one applied mutation.
# --------------------------------------------------------------------------
def _flip_verdict(body):
    body["verdict"] = "FAIL" if body["verdict"] == "PASS" else "PASS"
    return body


def _edit_input_sha256(body):
    h = body["input_sha256"]
    # Flip the first hex nibble to a different value (deterministic, 1 char).
    first = "1" if h[0] != "1" else "2"
    body["input_sha256"] = first + h[1:]
    return body


def _drop_failed_fatal_entry(body):
    if not body["failed_fatal_rules"]:
        raise _Skip("no fatal entry to drop")
    body["failed_fatal_rules"] = body["failed_fatal_rules"][1:]
    return body


def _alter_failed_fatal_rule_id(body):
    if not body["failed_fatal_rules"]:
        raise _Skip("no fatal entry to alter")
    body["failed_fatal_rules"][0]["rule"] = "BR-FORGED-99"
    return body


def _alter_failed_fatal_message(body):
    if not body["failed_fatal_rules"]:
        raise _Skip("no fatal entry to alter")
    body["failed_fatal_rules"][0]["message"] = "tampered message"
    return body


def _append_failed_fatal_entry(body):
    body["failed_fatal_rules"] = body["failed_fatal_rules"] + [
        {"rule": "BR-INJECTED-1", "message": "fabricated failure"}]
    return body


def _change_tool_version(body):
    body["tool"]["version"] = body["tool"]["version"] + ".tampered"
    return body


def _change_tool_name(body):
    body["tool"]["name"] = "not-einvoice"
    return body


def _change_profile(body):
    body["profile"] = "xrechnung" if body["profile"] != "xrechnung" else "en16931"
    return body


def _flip_well_formed(body):
    body["well_formed"] = not body["well_formed"]
    return body


def _change_format(body):
    body["format"] = body["format"] + "-tampered"
    return body


def _add_issued_at(body):
    if "issued_at" in body:
        raise _Skip("issued_at already present")
    body["issued_at"] = STAMP
    return body


def _remove_issued_at(body):
    if "issued_at" not in body:
        raise _Skip("no issued_at to remove")
    del body["issued_at"]
    return body


def _alter_issued_at(body):
    if "issued_at" not in body:
        raise _Skip("no issued_at to alter")
    body["issued_at"] = "2099-12-31T23:59:59Z"
    return body


MUTATORS = [
    ("flip_verdict",              "verdict",             _flip_verdict),
    ("edit_input_sha256",         "input_sha256",        _edit_input_sha256),
    ("drop_failed_fatal_entry",   "failed_fatal_rules",  _drop_failed_fatal_entry),
    ("alter_failed_fatal_rule",   "failed_fatal_rules",  _alter_failed_fatal_rule_id),
    ("alter_failed_fatal_msg",    "failed_fatal_rules",  _alter_failed_fatal_message),
    ("append_failed_fatal_entry", "failed_fatal_rules",  _append_failed_fatal_entry),
    ("change_tool_version",       "tool.version",        _change_tool_version),
    ("change_tool_name",          "tool.name",           _change_tool_name),
    ("change_profile",            "profile",             _change_profile),
    ("flip_well_formed",          "well_formed",         _flip_well_formed),
    ("change_format",             "format",              _change_format),
    ("add_issued_at",             "issued_at",           _add_issued_at),
    ("remove_issued_at",          "issued_at",           _remove_issued_at),
    ("alter_issued_at",           "issued_at",           _alter_issued_at),
]

#: Every body region the totality claim covers. The coverage guard asserts each
#: appears in at least one APPLIED (non-skipped) mutation across the base set.
REQUIRED_REGIONS = {
    "verdict", "input_sha256", "failed_fatal_rules", "tool.version",
    "tool.name", "profile", "well_formed", "format", "issued_at",
}


def _base_receipts():
    """The three base golden receipts (name -> full document)."""
    return {
        "pass-en16931": _build(*PASS_FIXTURE),
        "fail-creditnote": _build(*FAIL_FIXTURE),
        "pass-stamped": _build(*PASS_FIXTURE, issued_at=STAMP),
    }


class UntamperedVerifiesClean(unittest.TestCase):
    """(a) An honest receipt recompute-verifies; the check is not always-reject."""

    def test_every_base_receipt_verifies(self):
        for name, doc in _base_receipts().items():
            self.assertTrue(verify_recompute(doc),
                            "untampered %s must recompute-verify clean" % name)

    def test_reserialized_identical_body_still_verifies(self):
        # Round-tripping the body through JSON (a consumer parsing then
        # re-canonicalizing) must NOT be mistaken for tampering.
        for name, doc in _base_receipts().items():
            rebuilt = {
                "receipt": json.loads(json.dumps(doc["receipt"])),
                "content_sha256": doc["content_sha256"],
            }
            self.assertTrue(verify_recompute(rebuilt),
                            "%s: identical re-serialized body must verify" % name)

    def test_stamped_receipt_carries_issued_at(self):
        # Guards the STAMPED base actually exercises the issued_at remove/alter
        # mutators (fixture/behaviour drift would otherwise silently disarm them).
        self.assertIn("issued_at",
                      _build(*PASS_FIXTURE, issued_at=STAMP)["receipt"])
        self.assertNotIn("issued_at", _build(*PASS_FIXTURE)["receipt"])


class EveryFieldMutationIsRejected(unittest.TestCase):
    """(b) Table-driven totality: every applicable body mutation -> reject."""

    def test_all_mutations_rejected_and_regions_covered(self):
        bases = _base_receipts()
        applied = 0
        covered_regions = set()
        for base_name, doc in bases.items():
            stored = doc["content_sha256"]
            original_body = doc["receipt"]
            for mut_name, region, fn in MUTATORS:
                try:
                    mutated_body = fn(copy.deepcopy(original_body))
                except _Skip:
                    continue
                applied += 1
                covered_regions.add(region)
                label = "%s / %s" % (base_name, mut_name)

                # The mutator must have genuinely changed the body — otherwise
                # the reject assertion below would pass vacuously.
                self.assertNotEqual(
                    mutated_body, original_body,
                    "%s: mutator did not change the body (would be a vacuous "
                    "pass)" % label)

                # The consumer check reconstructs the document with the ORIGINAL
                # stored hash and the mutated body: recompute must now mismatch.
                tampered = {"receipt": mutated_body, "content_sha256": stored}
                self.assertFalse(
                    verify_recompute(tampered),
                    "%s: mutated body must be REJECTED (recomputed hash must "
                    "differ from the stored content_sha256)" % label)

        # Totality: every documented region was hit by >=1 applied mutation,
        # and the sub-field mutators of failed_fatal_rules all actually applied.
        missing = REQUIRED_REGIONS - covered_regions
        self.assertEqual(missing, set(),
                         "regions never exercised by an applied mutation: %s"
                         % sorted(missing))
        self.assertGreaterEqual(applied, len(REQUIRED_REGIONS),
                                "too few mutations applied: %d" % applied)

    def test_failed_fatal_subfield_mutators_apply_to_the_fail_receipt(self):
        # Explicitly prove the drop / alter-id / alter-message mutators are not
        # silently skipped everywhere (they need a non-empty failed_fatal_rules).
        doc = _build(*FAIL_FIXTURE)
        body = doc["receipt"]
        self.assertTrue(body["failed_fatal_rules"],
                        "FAIL fixture must carry >=1 fatal entry")
        for fn in (_drop_failed_fatal_entry, _alter_failed_fatal_rule_id,
                   _alter_failed_fatal_message):
            mutated = fn(copy.deepcopy(body))
            tampered = {"receipt": mutated, "content_sha256": doc["content_sha256"]}
            self.assertFalse(verify_recompute(tampered),
                             "%s must reject" % fn.__name__)


class OuterHashCorruptionAndItsLimit(unittest.TestCase):
    """(c) Corrupting content_sha256 itself is caught; the coordinated-rewrite
    limit of a self-contained digest is documented and asserted honestly."""

    def test_corrupting_content_sha256_is_rejected(self):
        # content_sha256 does NOT self-cover (it is a digest of the body only),
        # but corrupting it ALONE is still caught: the body is untouched, so the
        # recompute equals the receipt's TRUE hash, which no longer matches the
        # corrupted stored value.
        for name, doc in _base_receipts().items():
            good = doc["content_sha256"]
            bad = ("0" + good[1:]) if good[0] != "0" else ("1" + good[1:])
            self.assertNotEqual(good, bad)
            corrupted = {"receipt": doc["receipt"], "content_sha256": bad}
            self.assertFalse(verify_recompute(corrupted),
                             "%s: a corrupted content_sha256 must be REJECTED "
                             "by recompute-and-compare" % name)

    def test_truncated_or_missing_hash_is_rejected(self):
        doc = _build(*PASS_FIXTURE)
        # Truncated hex.
        self.assertFalse(verify_recompute(
            {"receipt": doc["receipt"], "content_sha256": doc["content_sha256"][:-1]}))
        # Empty string.
        self.assertFalse(verify_recompute(
            {"receipt": doc["receipt"], "content_sha256": ""}))
        # Missing entirely.
        self.assertFalse(verify_recompute({"receipt": doc["receipt"]}))

    def test_coordinated_body_and_hash_rewrite_verifies_clean_by_design(self):
        # The DEFINING limit of a self-contained digest, asserted honestly (NOT
        # a defect): an attacker who rewrites the body AND recomputes
        # content_sha256 over the forged body produces an internally consistent
        # receipt that recompute-verifies. Single-document recompute-and-compare
        # cannot detect this; only comparison against an independently held /
        # anchored hash (or reproducing the body from the original input) can.
        doc = _build(*PASS_FIXTURE)
        forged_body = copy.deepcopy(doc["receipt"])
        forged_body["verdict"] = "FAIL"          # flip the attested outcome
        forged_hash = hashlib.sha256(
            _consumer_canonical_json(forged_body).encode("utf-8")).hexdigest()
        forged_doc = {"receipt": forged_body, "content_sha256": forged_hash}
        # Internally consistent -> passes the self-contained check ...
        self.assertTrue(verify_recompute(forged_doc))
        # ... yet it is NOT the genuine receipt: its hash differs from the real
        # one, which is exactly what an external anchor / recompute-from-input
        # would compare against and reject.
        self.assertNotEqual(forged_hash, doc["content_sha256"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

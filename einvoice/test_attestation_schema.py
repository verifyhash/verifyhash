#!/usr/bin/env python3
"""test_attestation_schema.py — prove attestation.schema.json is a faithful,
machine-checkable contract for the canonical conformance-CLAIM attestation.

The committed ``attestation.schema.json`` (JSON Schema draft 2020-12) describes
the envelope emitted by ``python3 gen_attestation.py`` /
``gen_attestation.build_attestation`` — ``{"attestation": <body>,
"content_sha256": <hex>}``. This test mirrors ``test_receipt_schema.py`` /
``test_report_schema.py`` discipline:

  (a) loads attestation.schema.json, asserts it parses as JSON, is a
      draft-2020-12 schema, and carries the body ``format`` const ==
      ``gen_attestation.ATTESTATION_FORMAT`` (imported from the real emitter, so
      a future ATTESTATION_FORMAT bump without a matching schema bump fails this
      suite — the same drift guard the receipt/report schemas use);
  (b) validates the committed ``attestation.json`` against the schema and asserts
      it passes; and re-runs the REAL emitter (``build_attestation``) and
      validates its live output too, so the schema tracks the emitter, not a
      stale on-disk copy;
  (c) asserts deliberately-malformed attestations (wrong ``format`` const,
      missing ``content_sha256``, an unexpected extra body key, a wrong-typed
      ``coverage`` count) are REJECTED, proving the validator discriminates.

Validation uses a small, self-contained, STDLIB-ONLY recursive checker
(:func:`schema_errors`) — the SAME subset ``test_receipt_schema.py`` uses:
``type`` (single or list), ``required``, ``properties``, ``items``, ``enum``,
``const`` and ``additionalProperties: false``. It is a TEST-ONLY dependency: the
engine gains NO runtime dependency (``jsonschema`` is deliberately NOT imported),
which ``test_packaging.py`` continues to prove.

Fast, offline, saxonche-free.
"""

import copy
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import gen_attestation  # noqa: E402
from gen_attestation import ATTESTATION_FORMAT, build_attestation  # noqa: E402

SCHEMA_PATH = os.path.join(HERE, "attestation.schema.json")
ATTESTATION_PATH = os.path.join(HERE, "attestation.json")


# ---------------------------------------------------------------------------
# Minimal, self-contained JSON Schema validator (TEST-ONLY, stdlib only).
# Implements exactly the keywords attestation.schema.json relies on for
# discrimination. Returns a list of human-readable error strings; an empty list
# means the instance is valid. (Same subset shape test_receipt_schema.py uses.)
# ---------------------------------------------------------------------------
def _type_ok(instance, t):
    """True iff ``instance`` matches JSON Schema primitive type name ``t``.

    ``bool`` is deliberately excluded from ``integer``/``number`` because in
    Python ``bool`` is a subclass of ``int`` and JSON Schema treats true/false
    as a distinct type from numbers.
    """
    if t == "object":
        return isinstance(instance, dict)
    if t == "array":
        return isinstance(instance, list)
    if t == "string":
        return isinstance(instance, str)
    if t == "integer":
        return isinstance(instance, int) and not isinstance(instance, bool)
    if t == "number":
        return isinstance(instance, (int, float)) and not isinstance(instance, bool)
    if t == "boolean":
        return isinstance(instance, bool)
    if t == "null":
        return instance is None
    raise ValueError("unsupported schema type: %r" % (t,))


def schema_errors(instance, schema, path="$"):
    """Recursively validate ``instance`` against ``schema``.

    Supported keywords (exactly the subset attestation.schema.json uses):
    ``type`` (a string or a list of strings), ``const``, ``enum``,
    ``properties``, ``required``, ``items`` and ``additionalProperties`` — as
    ``false`` (reject unknown keys) OR as a subschema (validate every value not
    named in ``properties`` against it, which is how the open ``by_family`` /
    ``artifacts`` maps are checked). Any other keyword (``$schema``, ``$id``,
    ``title``, ``description``) is ignored. Returns a list of error strings
    (empty == valid).
    """
    errors = []

    if "type" in schema:
        types = schema["type"]
        if isinstance(types, str):
            types = [types]
        if not any(_type_ok(instance, t) for t in types):
            errors.append("%s: expected type %s, got %s"
                          % (path, types, type(instance).__name__))

    if "const" in schema and instance != schema["const"]:
        errors.append("%s: expected const %r, got %r"
                      % (path, schema["const"], instance))

    if "enum" in schema and instance not in schema["enum"]:
        errors.append("%s: %r not in enum %r" % (path, instance, schema["enum"]))

    if isinstance(instance, dict):
        props = schema.get("properties", {})
        if "required" in schema:
            for key in schema["required"]:
                if key not in instance:
                    errors.append("%s: missing required property %r" % (path, key))
        addl = schema.get("additionalProperties", None)
        if addl is False:
            for key in instance:
                if key not in props:
                    errors.append("%s: unexpected property %r" % (path, key))
        for key, subschema in props.items():
            if key in instance:
                errors += schema_errors(instance[key], subschema,
                                        "%s.%s" % (path, key))
        if isinstance(addl, dict):
            for key, value in instance.items():
                if key not in props:
                    errors += schema_errors(value, addl,
                                            "%s.%s" % (path, key))

    if isinstance(instance, list) and "items" in schema:
        for i, element in enumerate(instance):
            errors += schema_errors(element, schema["items"],
                                    "%s[%d]" % (path, i))

    return errors


def load_schema():
    with open(SCHEMA_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def load_committed_attestation():
    with open(ATTESTATION_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def _body_props(schema):
    return schema["properties"]["attestation"]["properties"]


class ValidatorSelfTest(unittest.TestCase):
    """Prove the tiny validator itself accepts/rejects correctly, so a green
    fixture result actually means something."""

    def test_type_and_const_and_required_and_additional_false(self):
        s = {"type": "object", "required": ["a"], "additionalProperties": False,
             "properties": {"a": {"const": 1},
                            "n": {"type": ["string", "null"]}}}
        self.assertEqual(schema_errors({"a": 1}, s), [])
        self.assertEqual(schema_errors({"a": 1, "n": None}, s), [])
        self.assertTrue(schema_errors({"a": 2}, s))            # const mismatch
        self.assertTrue(schema_errors({}, s))                 # missing required
        self.assertTrue(schema_errors({"a": 1, "z": 9}, s))   # additional prop

    def test_integer_excludes_bool(self):
        self.assertEqual(schema_errors(3, {"type": "integer"}), [])
        self.assertTrue(schema_errors(True, {"type": "integer"}))

    def test_additionalproperties_subschema_validates_open_map_values(self):
        # An open map: keys are arbitrary, values must all be integers.
        s = {"type": "object", "additionalProperties": {"type": "integer"}}
        self.assertEqual(schema_errors({"core": 209, "x": 1}, s), [])
        self.assertTrue(schema_errors({"core": "209"}, s))     # value wrong type

    def test_items(self):
        s = {"type": "array", "items": {"type": "string"}}
        self.assertEqual(schema_errors(["a", "b"], s), [])
        self.assertTrue(schema_errors(["a", 1], s))


class SchemaDocument(unittest.TestCase):
    def test_schema_parses_and_is_draft_2020_12(self):
        schema = load_schema()
        self.assertIsInstance(schema, dict)
        self.assertEqual(schema["$schema"],
                         "https://json-schema.org/draft/2020-12/schema")
        self.assertIn("$id", schema)
        self.assertEqual(schema["type"], "object")
        # Envelope requires exactly the two envelope fields, no extras.
        self.assertEqual(set(schema["required"]),
                         {"attestation", "content_sha256"})
        self.assertIs(schema["additionalProperties"], False)

    def test_format_const_is_derived_bound_to_the_emitter(self):
        """The schema's body `format` const MUST equal the emitter's
        ATTESTATION_FORMAT. This is the drift guard: bumping ATTESTATION_FORMAT
        without bumping the schema (or vice versa) turns this red."""
        schema = load_schema()
        body_props = _body_props(schema)
        self.assertEqual(body_props["format"]["const"], ATTESTATION_FORMAT)
        self.assertEqual(body_props["format"]["const"],
                         "einvoice-conformance-attestation/1")

    def test_body_requires_the_six_core_sections(self):
        schema = load_schema()
        body = schema["properties"]["attestation"]
        self.assertEqual(
            set(body["required"]),
            {"format", "rules", "coverage", "testsuite_conformance",
             "corpus", "artifacts"})
        self.assertIs(body["additionalProperties"], False)


class CommittedAttestationValidates(unittest.TestCase):
    """The committed attestation.json AND a fresh build_attestation() run must
    both validate against the committed schema."""

    def test_committed_attestation_validates(self):
        doc = load_committed_attestation()
        errors = schema_errors(doc, load_schema())
        self.assertEqual(errors, [],
                         "schema rejected the committed attestation.json:\n%s"
                         % "\n".join(errors))

    def test_live_emitter_output_validates(self):
        doc = build_attestation()
        errors = schema_errors(doc, load_schema())
        self.assertEqual(errors, [],
                         "schema rejected live build_attestation() output:\n%s"
                         % "\n".join(errors))
        # And the committed file is byte-consistent with the live emitter.
        self.assertEqual(doc, load_committed_attestation())

    def test_format_field_matches_the_const(self):
        doc = load_committed_attestation()
        self.assertEqual(doc["attestation"]["format"], ATTESTATION_FORMAT)


class MalformedAttestationsRejected(unittest.TestCase):
    """The validator must REJECT attestations that break the contract —
    otherwise a green run proves nothing. Five distinct malformed shapes (well
    over the required four)."""

    def _base(self):
        return copy.deepcopy(load_committed_attestation())

    def test_wrong_format_const_rejected(self):
        doc = self._base()
        doc["attestation"]["format"] = "einvoice-conformance-attestation/2"
        self.assertTrue(schema_errors(doc, load_schema()),
                        "a bumped format const must be rejected")

    def test_missing_content_sha256_rejected(self):
        doc = self._base()
        doc.pop("content_sha256")
        self.assertTrue(schema_errors(doc, load_schema()),
                        "an attestation missing content_sha256 must be rejected")

    def test_unexpected_extra_body_key_rejected(self):
        doc = self._base()
        doc["attestation"]["totally_new_section"] = 123
        self.assertTrue(schema_errors(doc, load_schema()),
                        "additionalProperties:false must reject unknown body keys")

    def test_wrong_typed_coverage_count_rejected(self):
        doc = self._base()
        # business_rules_total_asserted is an integer; a string must be rejected.
        doc["attestation"]["coverage"]["business_rules_total_asserted"] = "286"
        self.assertTrue(schema_errors(doc, load_schema()),
                        "a string coverage count must be rejected")

    def test_corpus_item_missing_required_field_rejected(self):
        doc = self._base()
        doc["attestation"]["corpus"][0].pop("sha256")
        self.assertTrue(schema_errors(doc, load_schema()),
                        "a corpus entry missing sha256 must be rejected")


if __name__ == "__main__":
    unittest.main(verbosity=2)

#!/usr/bin/env python3
"""test_receipt_schema.py — prove receipt.schema.json is a faithful, machine-
checkable contract for the canonical conformance receipt.

The committed ``receipt.schema.json`` (JSON Schema draft 2020-12) describes the
envelope emitted by ``python3 -m einvoice receipt`` /
``einvoice.receipt.build_receipt`` — ``{"receipt": <body>, "content_sha256":
<hex>}``. This test mirrors ``test_report_schema.py``'s discipline:

  (a) loads receipt.schema.json, asserts it parses as JSON, is a draft-2020-12
      schema, and carries the body ``format`` const == ``receipt.RECEIPT_FORMAT``
      (imported from the engine, so a future RECEIPT_FORMAT bump without a
      matching schema bump fails this suite — the same drift guard the report
      schema uses for its ``schema`` const);
  (b) runs the REAL engine (build_receipt) over the same committed golden
      fixtures the receipt golden snapshots are built from — a valid + an
      invalid UBL and a valid + an invalid CII/Factur-X invoice — and validates
      each emitted receipt against the schema;
  (c) asserts deliberately-malformed receipts (flipped ``verdict`` enum value,
      missing ``content_sha256``, an unexpected extra body key, a wrong
      ``format`` const) are REJECTED, proving the validator discriminates.

Validation uses a small, self-contained, STDLIB-ONLY recursive checker
(:func:`schema_errors`) implementing EXACTLY the JSON Schema subset the schema
uses — ``type`` (single or list), ``required``, ``properties``, ``items``,
``enum``, ``const`` and ``additionalProperties: false``. It is a TEST-ONLY
dependency: the engine gains no runtime dependency (``jsonschema`` is
deliberately NOT imported), which ``test_packaging.py`` continues to prove.

Note on the CII path (T-VHCII3.5, delivered with T-VHCII3.1): ``build_receipt``
validates through ``validate_file``, whose root dispatch now routes a
``CrossIndustryInvoice`` to the CII engine, so a CII/Factur-X XML yields its
REAL graded receipt — PASS with an empty ``failed_fatal_rules`` for a clean
document, FAIL naming the real business rules for a broken one — instead of the
structural ``S-ROOT`` FAIL it used to. The receipt SCHEMA is unchanged: the
same body keys, the same ``content_sha256`` discipline, no new field and no new
format version. That is exactly the point of asserting both CII legs here.

Fast, offline, saxonche-free.
"""

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.receipt import (  # noqa: E402
    build_receipt, canonical_json, RECEIPT_FORMAT, _sha256_hex)

SCHEMA_PATH = os.path.join(HERE, "receipt.schema.json")

# --- Fixtures (reused from the committed corpus; no new corpus added) --------
# These are the SAME source invoices the golden receipt snapshots are built from
# (see RECEIPT_FIXTURES in test_golden_snapshot.py): a valid + an invalid UBL and
# a valid + an invalid CII, each run through the REAL build_receipt engine.
VALID_UBL = os.path.join(
    HERE, "corpus", "vendored", "valid", "xr-01.01a_ubl.xml")
# UBL CreditNote with BT-3=999 -> one BR-CL-01 fatal (real rule, shared engine).
INVALID_UBL = os.path.join(
    HERE, "fixtures", "creditnote-invalid-typecode_ubl.xml")
# Reference EN 16931 CII invoice, EN-core clean: the receipt path grades it on
# the CII engine, so it is a PASS receipt with failed_fatal_rules empty.
VALID_CII = os.path.join(
    HERE, "corpus", "cen-en16931", "cii", "examples", "CII_example5.xml")
# Synthetic CII with a VAT-total mismatch -> a FAIL receipt naming the real
# BR-CO-14, with its own distinct input_sha256.
INVALID_CII = os.path.join(
    HERE, "corpus", "synthetic", "synth-cii-bad-vat-mismatch.xml")


# ---------------------------------------------------------------------------
# Minimal, self-contained JSON Schema validator (TEST-ONLY, stdlib only).
# Implements exactly the keywords receipt.schema.json uses. Returns a list of
# human-readable error strings; an empty list means the instance is valid.
# (Same subset shape test_report_schema.py uses.)
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

    Supported keywords (exactly the subset receipt.schema.json uses):
    ``type`` (a string or a list of strings), ``const``, ``enum``,
    ``properties``, ``required``, ``items`` and ``additionalProperties: false``.
    Any other keyword (``$schema``, ``$id``, ``title``, ``description``) is
    ignored. Returns a list of error strings (empty == valid).
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
        if schema.get("additionalProperties") is False:
            for key in instance:
                if key not in props:
                    errors.append("%s: unexpected property %r" % (path, key))
        for key, subschema in props.items():
            if key in instance:
                errors += schema_errors(instance[key], subschema,
                                        "%s.%s" % (path, key))

    if isinstance(instance, list) and "items" in schema:
        for i, element in enumerate(instance):
            errors += schema_errors(element, schema["items"],
                                    "%s[%d]" % (path, i))

    return errors


def load_schema():
    with open(SCHEMA_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def _body_props(schema):
    return schema["properties"]["receipt"]["properties"]


class ValidatorSelfTest(unittest.TestCase):
    """Prove the tiny validator itself accepts/rejects correctly, so a green
    fixture result actually means something."""

    def test_type_and_const_and_enum(self):
        s = {"type": "object", "required": ["a"], "additionalProperties": False,
             "properties": {"a": {"const": 1},
                            "b": {"enum": ["x", "y"]},
                            "n": {"type": ["string", "null"]}}}
        self.assertEqual(schema_errors({"a": 1}, s), [])
        self.assertEqual(schema_errors({"a": 1, "n": None}, s), [])
        self.assertTrue(schema_errors({"a": 2}, s))            # const mismatch
        self.assertTrue(schema_errors({}, s))                 # missing required
        self.assertTrue(schema_errors({"a": 1, "z": 9}, s))   # additional prop
        self.assertTrue(schema_errors({"a": 1, "b": "z"}, s))  # enum miss

    def test_integer_excludes_bool(self):
        self.assertEqual(schema_errors(3, {"type": "integer"}), [])
        self.assertTrue(schema_errors(True, {"type": "integer"}))

    def test_boolean_and_items(self):
        self.assertEqual(schema_errors(True, {"type": "boolean"}), [])
        self.assertTrue(schema_errors("nope", {"type": "boolean"}))
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
        self.assertEqual(set(schema["required"]), {"receipt", "content_sha256"})
        self.assertIs(schema["additionalProperties"], False)

    def test_format_const_is_derived_bound_to_the_engine(self):
        """The schema's body `format` const MUST equal the engine's
        RECEIPT_FORMAT. This is the drift guard: bumping RECEIPT_FORMAT without
        bumping the schema (or vice versa) turns this red."""
        schema = load_schema()
        body_props = _body_props(schema)
        self.assertEqual(body_props["format"]["const"], RECEIPT_FORMAT)
        self.assertEqual(body_props["format"]["const"],
                         "einvoice-conformance-receipt/1")

    def test_body_requires_seven_core_fields_issued_at_optional(self):
        schema = load_schema()
        body = schema["properties"]["receipt"]
        self.assertEqual(
            set(body["required"]),
            {"format", "tool", "profile", "well_formed", "verdict",
             "input_sha256", "failed_fatal_rules"})
        self.assertIs(body["additionalProperties"], False)
        # issued_at is described but NOT required.
        self.assertIn("issued_at", body["properties"])
        self.assertNotIn("issued_at", body["required"])
        # profile and verdict are enums with the documented members.
        props = body["properties"]
        self.assertEqual(set(props["profile"]["enum"]), {"en16931", "xrechnung"})
        self.assertEqual(set(props["verdict"]["enum"]), {"PASS", "FAIL"})


class RealEngineOutputValidates(unittest.TestCase):
    """build_receipt output for valid+invalid UBL and valid+invalid CII must all
    validate against the committed schema."""

    def _check(self, path, profile, expect_verdict):
        self.assertTrue(os.path.exists(path), "fixture missing: %s" % path)
        doc = build_receipt(path, profile=profile)
        errors = schema_errors(doc, load_schema())
        self.assertEqual(errors, [],
                         "schema rejected real receipt for %s:\n%s\nreceipt=%s"
                         % (os.path.basename(path), "\n".join(errors),
                            json.dumps(doc)[:2000]))
        self.assertEqual(doc["receipt"]["verdict"], expect_verdict,
                         "unexpected verdict for %s" % os.path.basename(path))
        # No timestamp leaks in by default: the optional key stays absent.
        self.assertNotIn("issued_at", doc["receipt"])
        return doc

    def test_valid_ubl_passes(self):
        doc = self._check(VALID_UBL, "en16931", expect_verdict="PASS")
        self.assertEqual(doc["receipt"]["failed_fatal_rules"], [])

    def test_invalid_ubl_fails_with_fatal_rule(self):
        doc = self._check(INVALID_UBL, "en16931", expect_verdict="FAIL")
        rules = [r["rule"] for r in doc["receipt"]["failed_fatal_rules"]]
        self.assertIn("BR-CL-01", rules)

    def test_valid_cii_receipt_validates(self):
        # Graded on the CII engine via the shared root dispatch: a genuine PASS
        # receipt, in the SAME schema shape a clean UBL invoice produces.
        doc = self._check(VALID_CII, "en16931", expect_verdict="PASS")
        self.assertEqual(doc["receipt"]["failed_fatal_rules"], [])
        # Same content_sha256 discipline as UBL: the hash recomputes from the
        # canonicalized body, no CII-specific field or exemption.
        self.assertEqual(doc["content_sha256"],
                         _sha256_hex(canonical_json(doc["receipt"])
                                     .encode("utf-8")))

    def test_invalid_cii_receipt_validates(self):
        doc = self._check(INVALID_CII, "en16931", expect_verdict="FAIL")
        rules = [r["rule"] for r in doc["receipt"]["failed_fatal_rules"]]
        # The REAL business rule, never a structural refusal.
        self.assertEqual(rules, ["BR-CO-14"])
        self.assertNotIn("S-ROOT", rules)

    def test_cii_and_ubl_receipts_share_one_body_shape(self):
        """No new receipt field and no new format version for CII: the body
        keys of a CII receipt are exactly those of a UBL receipt."""
        cii = build_receipt(VALID_CII, profile="en16931")
        ubl = build_receipt(VALID_UBL, profile="en16931")
        self.assertEqual(set(cii["receipt"]), set(ubl["receipt"]))
        self.assertEqual(set(cii), set(ubl))
        self.assertEqual(cii["receipt"]["format"], ubl["receipt"]["format"])

    def test_explicit_issued_at_still_validates(self):
        # When a caller DOES pass issued_at, the (now-optional-present) key is
        # accepted by the schema.
        doc = build_receipt(VALID_UBL, profile="en16931",
                            issued_at="2026-01-01T00:00:00Z")
        self.assertEqual(schema_errors(doc, load_schema()), [])
        self.assertEqual(doc["receipt"]["issued_at"], "2026-01-01T00:00:00Z")


class MalformedReceiptsRejected(unittest.TestCase):
    """The validator must REJECT receipts that break the contract — otherwise a
    green run proves nothing. Four distinct malformed shapes."""

    def _base(self):
        return build_receipt(VALID_UBL, profile="en16931")

    def test_flipped_verdict_enum_value_rejected(self):
        doc = self._base()
        doc["receipt"]["verdict"] = "PASSED"   # not in {PASS, FAIL}
        self.assertTrue(schema_errors(doc, load_schema()),
                        "an out-of-enum verdict must be rejected")

    def test_missing_content_sha256_rejected(self):
        doc = self._base()
        doc.pop("content_sha256")
        self.assertTrue(schema_errors(doc, load_schema()),
                        "a receipt missing content_sha256 must be rejected")

    def test_unexpected_extra_body_key_rejected(self):
        doc = self._base()
        doc["receipt"]["totally_new_field"] = 123
        self.assertTrue(schema_errors(doc, load_schema()),
                        "additionalProperties:false must reject unknown body keys")

    def test_wrong_format_const_rejected(self):
        doc = self._base()
        doc["receipt"]["format"] = "einvoice-conformance-receipt/2"
        self.assertTrue(schema_errors(doc, load_schema()),
                        "a receipt with a bumped format const must be rejected")

    def test_bad_failed_fatal_rule_shape_rejected(self):
        doc = self._base()
        doc["receipt"]["failed_fatal_rules"].append({"rule": "X"})  # no message
        self.assertTrue(schema_errors(doc, load_schema()),
                        "a fatal-rule entry missing `message` must be rejected")


if __name__ == "__main__":
    unittest.main(verbosity=2)

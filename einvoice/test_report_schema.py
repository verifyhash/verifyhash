#!/usr/bin/env python3
"""test_report_schema.py — prove report.schema.json is a faithful, machine-
checkable contract for the canonical conformance report.

The committed ``report.schema.json`` (JSON Schema draft 2020-12) describes the
single-document report emitted by ``python3 -m einvoice.report`` /
``einvoice.report.build_report``. This test:

  (a) loads report.schema.json and asserts it parses as JSON and is a
      draft-2020-12 schema carrying the version const;
  (b) runs the REAL engine (build_report) on four corpus fixtures — a valid
      and an invalid UBL invoice AND a valid and an invalid CII (Factur-X)
      invoice, including a UBL fixture that drives the ``syntax_bindings``
      block non-empty — and validates each report against the schema;
  (c) asserts deliberately-malformed reports (missing ``schema``, wrong
      ``report_version``, a bad severity enum, an unexpected extra key) are
      REJECTED, proving the validator actually discriminates.

Validation uses a small, self-contained, STDLIB-ONLY recursive checker
(:func:`schema_errors`) that implements EXACTLY the JSON Schema subset the
schema uses — ``type`` (single or list), ``required``, ``properties``,
``items``, ``enum``, ``const`` and ``additionalProperties: false``. It is a
TEST-ONLY dependency: the engine gains no runtime dependency (``jsonschema`` is
deliberately NOT imported), which ``test_packaging.py`` continues to prove.

Fast, offline, saxonche-free.
"""

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.report import (  # noqa: E402
    build_report,
    REPORT_SCHEMA_ID,
    REPORT_VERSION,
)

SCHEMA_PATH = os.path.join(HERE, "report.schema.json")

# --- Fixtures (reused from the existing corpus; no new corpus added) ---------
# Valid + invalid UBL, valid + invalid CII. The plain-XML UBL path carries the
# syntax_bindings block; the CII path is reached via the Factur-X PDF container
# (build_report dispatches on the %PDF- magic and validates the embedded CII).
VALID_UBL = os.path.join(
    HERE, "corpus", "xrechnung-testsuite", "src", "test", "business-cases",
    "standard", "01.01a-INVOICE_ubl.xml")
# A UBL invoice that trips a fatal syntax-binding restriction (UBL-SR-11):
# invalid AND drives report["syntax_bindings"] non-empty.
INVALID_UBL_SB = os.path.join(
    HERE, "corpus", "vendored", "syntax-binding", "sb-viol-UBL-SR-11_ubl.xml")
# Factur-X PDFs: the embedded CrossIndustryInvoice is validated by the real CII
# engine. facturx-valid passes en16931; facturx-bad fails hard under xrechnung.
VALID_CII = os.path.join(HERE, "corpus", "pdf", "facturx-valid.pdf")
INVALID_CII = os.path.join(HERE, "corpus", "pdf", "facturx-bad.pdf")


# ---------------------------------------------------------------------------
# Minimal, self-contained JSON Schema validator (TEST-ONLY, stdlib only).
# Implements exactly the keywords report.schema.json uses. Returns a list of
# human-readable error strings; an empty list means the instance is valid.
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

    Supported keywords (exactly the subset report.schema.json uses):
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

    def test_schema_pins_the_version_and_matches_the_engine(self):
        schema = load_schema()
        props = schema["properties"]
        # The version is carried by the `schema` const + the `report_version`
        # const, and must not drift from the engine constants.
        self.assertEqual(props["schema"]["const"], REPORT_SCHEMA_ID)
        self.assertEqual(props["schema"]["const"],
                         "einvoice-conformance-report/v1")
        self.assertEqual(props["report_version"]["const"], REPORT_VERSION)
        # Both the core violations array and the syntax_bindings array (+ its
        # count fields) are described.
        self.assertIn("violations", props)
        self.assertIn("syntax_bindings", props)
        self.assertIn("syntax_binding_fatal_count", props)
        self.assertIn("syntax_binding_warning_count", props)


class RealEngineOutputValidates(unittest.TestCase):
    """build_report output for valid+invalid UBL and valid+invalid CII must all
    validate against the committed schema."""

    def _check(self, path, profile, expect_valid):
        self.assertTrue(os.path.exists(path), "fixture missing: %s" % path)
        report = build_report(path, profile=profile)
        errors = schema_errors(report, load_schema())
        self.assertEqual(errors, [],
                         "schema rejected real report for %s:\n%s\nreport=%s"
                         % (os.path.basename(path), "\n".join(errors),
                            json.dumps(report)[:2000]))
        self.assertEqual(report["valid"], expect_valid,
                         "unexpected validity for %s" % os.path.basename(path))
        return report

    def test_valid_ubl(self):
        r = self._check(VALID_UBL, "xrechnung", expect_valid=True)
        # UBL plain-XML path carries the syntax-binding block.
        self.assertIn("syntax_bindings", r)

    def test_invalid_ubl_exercises_syntax_bindings(self):
        r = self._check(INVALID_UBL_SB, "xrechnung", expect_valid=False)
        self.assertGreaterEqual(len(r["syntax_bindings"]), 1,
                                "expected a non-empty syntax_bindings block")
        # The finding shape the schema describes is really present.
        sb = r["syntax_bindings"][0]
        self.assertEqual(sb["category"], "syntax-binding")
        self.assertIn(sb["severity"], ("fatal", "warning"))

    def test_valid_cii(self):
        r = self._check(VALID_CII, "en16931", expect_valid=True)
        # PDF/CII path does NOT carry the syntax-binding block — the schema
        # accepts its absence (those keys are optional).
        self.assertNotIn("syntax_bindings", r)

    def test_invalid_cii(self):
        r = self._check(INVALID_CII, "xrechnung", expect_valid=False)
        self.assertGreater(r["fatal_count"], 0)


class MalformedReportsRejected(unittest.TestCase):
    """The validator must REJECT reports that break the contract — otherwise a
    green run proves nothing."""

    def _base(self):
        return build_report(VALID_UBL, profile="xrechnung")

    def test_missing_schema_field_rejected(self):
        report = self._base()
        report.pop("schema")
        self.assertTrue(schema_errors(report, load_schema()),
                        "a report missing `schema` must be rejected")

    def test_wrong_report_version_rejected(self):
        report = self._base()
        report["report_version"] = 2
        self.assertTrue(schema_errors(report, load_schema()),
                        "a report with report_version != 1 must be rejected")

    def test_wrong_schema_id_rejected(self):
        report = self._base()
        report["schema"] = "einvoice-conformance-report/v2"
        self.assertTrue(schema_errors(report, load_schema()))

    def test_unexpected_extra_key_rejected(self):
        report = self._base()
        report["totally_new_field"] = 123
        self.assertTrue(schema_errors(report, load_schema()),
                        "additionalProperties:false must reject unknown keys")

    def test_bad_violation_severity_rejected(self):
        report = self._base()
        report["violations"].append({
            "rule": "X", "severity": "catastrophic", "message": "m",
            "field": None, "title": None, "fix_hint": None,
            "terms": [], "location": None})
        self.assertTrue(schema_errors(report, load_schema()),
                        "an out-of-enum severity must be rejected")


if __name__ == "__main__":
    unittest.main()

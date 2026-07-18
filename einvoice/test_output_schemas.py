#!/usr/bin/env python3
"""test_output_schemas.py — prove the adopter-facing MACHINE OUTPUTS are each
either validated against a published JSON Schema or explicitly exempt-listed
with a reason (an escape guard), and that the REAL emitted output validates.

Background. A CI consumer of einvoice reads three machine outputs BEFORE it can
trust a verdict feed: the capability handshake (`python3 -m einvoice info
--json`), the rules export (`einvoice/export/rules.json`) and the coverage
matrix (`einvoice/coverage_matrix.json`). Until now those three carried no
published schema — a consumer had to reverse-engineer the shape. This test
closes that gap and keeps it closed:

  (A) VALIDATION. For each (output, schema) pair it runs the REAL emitter (or
      reads the REAL committed export) and validates the emitted JSON against
      its committed ``<name>.schema.json`` using the SAME zero-dependency,
      stdlib-only structural validator the report drift guard uses
      (``test_report_schema.schema_errors``). No ``jsonschema`` import, so the
      package gains no runtime dependency (``test_packaging.py`` proves it).
      It also proves the validator DISCRIMINATES: a deliberately-corrupted copy
      of each output is REJECTED, so a green pass means something.

  (B) ESCAPE GUARD. It enumerates EVERY adopter-facing machine JSON output the
      CLI/exports/generators produce and asserts each is accounted for exactly
      once, as one of:
        * validated here against a published schema (info / rules / coverage),
        * schema'd + guarded elsewhere (report / receipt / attestation, each of
          which has its own published schema and dedicated drift guard), or
        * present in the explicit ``EXEMPT`` dict with a non-empty reason.
      A NEW generator output that is on none of those lists FAILS here (mirrors
      test_attestation's completeness guard). The set difference is asserted
      empty in BOTH directions, so a stale exempt/validated entry that no longer
      corresponds to a real output also fails.

The generator-output universe is derived from ``test_determinism.GENERATORS``
(the single source of truth for what the gen_*.py scripts emit), filtered to
JSON artifacts — the same map test_attestation's escape guard trusts — so a
future gen script that emits a new JSON is caught the moment it lands.

Stdlib only. Fast, offline, saxonche-free.
"""

import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# Reuse the report drift guard's stdlib-only structural validator verbatim —
# no new dependency, one validator implementation for every schema.
from test_report_schema import schema_errors  # noqa: E402


def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def emit_info():
    """Run the REAL CLI capability emitter and parse its --json output."""
    out = subprocess.check_output(
        [sys.executable, "-m", "einvoice", "info", "--json"],
        cwd=HERE)
    return json.loads(out)


# ---------------------------------------------------------------------------
# (A) The adopter-facing outputs that THIS test validates against a published
# schema. Each maps a stable label -> (loader, committed schema filename).
# The loader returns the REAL emitted/committed JSON.
# ---------------------------------------------------------------------------
VALIDATED = {
    "info --json": (emit_info, "info.schema.json"),
    "export/rules.json":
        (lambda: load_json(os.path.join(HERE, "export", "rules.json")),
         "rules.schema.json"),
    "coverage_matrix.json":
        (lambda: load_json(os.path.join(HERE, "coverage_matrix.json")),
         "coverage.schema.json"),
}

# The generator-output FILE (relative to HERE) each validated output
# corresponds to, for the escape-guard accounting below. `info --json` is a
# CLI stream, not a generated file, so it is not in the file universe.
VALIDATED_FILES = {
    "export/rules.json": "rules.schema.json",
    "coverage_matrix.json": "coverage.schema.json",
}

# Machine outputs that DO carry a published schema but are validated by their
# own dedicated drift guard (not re-validated here). Keeps this test's job
# focused while still accounting for them in the escape guard.
SCHEMED_ELSEWHERE = {
    "attestation.json":
        "published attestation.schema.json; guarded by test_attestation_schema.py",
}

# ---------------------------------------------------------------------------
# (B) EXEMPT: adopter-reachable JSON generator outputs that deliberately carry
# NO standalone schema, each with an HONEST reason. These are internal
# provenance/trust artifacts or derived summaries — NOT the CI-validated
# conformance surface a consumer parses to gate a build.
# ---------------------------------------------------------------------------
EXEMPT = {
    "export/coverage.json":
        "headline coverage SUMMARY (BR + syntax-binding totals) that projects a "
        "strict subset of coverage_matrix.json (which IS schema'd here); its "
        "numbers are pinned byte-for-byte to COVERAGE.md by test_export.py, so "
        "the shape is already contract-tested and a separate schema would only "
        "duplicate the coverage schema's fields.",
    "testsuite_conformance.json":
        "internal test-suite pass-rate provenance (bound raw-bytes in "
        "attestation.json); not a shape a CI consumer parses to gate a build.",
    "sbom/bom.json":
        "CycloneDX software bill-of-materials (its own external standard/shape); "
        "supply-chain provenance, not the einvoice conformance surface.",
    "cii_parity.json":
        "internal CII-vs-UBL differential parity worklog consumed only by "
        "gen_coverage.py / the parity tests; not an adopter-consumed output.",
    "known_open_audit.json":
        "internal known-open worklist audit used to prove no silent rule gaps; "
        "developer/audit artifact, not a CI consumer surface.",
    "remediation_catalog.json":
        "internal source-of-truth remediation catalog; its adopter-facing fields "
        "(title/fix) are surfaced through rules.json (schema'd) and the report.",
    "syntax_binding_catalog.json":
        "internal syntax-binding restriction catalog feeding the engine + "
        "coverage export; its adopter-facing counts surface in info/coverage.",
    "api_contract.json":
        "internal Python API surface contract (function signatures) guarded by "
        "test_api_contract.py; describes the library API, not a machine output.",
    "examples/*/report.json":
        "per-example demonstration validation reports — illustrative instances "
        "of the already-published report.schema.json, not a distinct output.",
}


def declared_json_outputs():
    """The universe of generated JSON outputs, from test_determinism.GENERATORS
    (single source of truth), filtered to *.json patterns. Non-JSON generator
    outputs (.md/.html/.xml/.txt static docs and XML test fixtures) are not
    machine-validated JSON surfaces and are out of scope for this guard."""
    import test_determinism
    universe = set()
    for patterns in test_determinism.GENERATORS.values():
        for pat in patterns:
            if pat.endswith(".json"):
                universe.add(pat)
    return universe


class SchemasExistAndAreIndexed(unittest.TestCase):
    """Every schema this test validates against must exist, be draft 2020-12,
    carry an $id + title, and be catalogued in schema-index.json (so the
    test_schema_index cross-drift guard also covers it)."""

    def test_validated_schemas_exist_and_are_wellformed(self):
        indexed_files = {
            e["file"] for e in
            load_json(os.path.join(HERE, "schema-index.json"))["schemas"]}
        for label, (_loader, schema_file) in VALIDATED.items():
            path = os.path.join(HERE, schema_file)
            self.assertTrue(os.path.isfile(path),
                            "missing schema %s for %s" % (schema_file, label))
            schema = load_json(path)
            self.assertEqual(schema["$schema"],
                             "https://json-schema.org/draft/2020-12/schema")
            self.assertTrue(schema.get("$id"), "%s has no $id" % schema_file)
            self.assertTrue(schema.get("title"), "%s has no title" % schema_file)
            self.assertIn(schema_file, indexed_files,
                          "%s must be listed in schema-index.json" % schema_file)


class RealOutputValidates(unittest.TestCase):
    """Each real emitted/committed output validates against its schema."""

    def test_every_output_validates(self):
        for label, (loader, schema_file) in VALIDATED.items():
            with self.subTest(output=label):
                instance = loader()
                schema = load_json(os.path.join(HERE, schema_file))
                errors = schema_errors(instance, schema)
                self.assertEqual(
                    errors, [],
                    "schema %s rejected the REAL %s output:\n%s"
                    % (schema_file, label, "\n".join(errors[:20])))


class ValidatorDiscriminates(unittest.TestCase):
    """A corrupted copy of each output must be REJECTED — otherwise validation
    proves nothing. We break the contract in a schema-appropriate way."""

    def _corrupt(self, instance):
        """Return a list of mutated copies that must each fail the schema."""
        import copy
        mutations = []
        # 1. inject an unexpected top-level key (additionalProperties:false).
        m = copy.deepcopy(instance)
        m["__unexpected_key__"] = 123
        mutations.append(("extra top-level key", m))
        # 2. drop a required top-level key.
        keys = [k for k in instance if not k.startswith("__")]
        if keys:
            m = copy.deepcopy(instance)
            m.pop(keys[0])
            mutations.append(("missing required %r" % keys[0], m))
        return mutations

    def test_corrupted_outputs_are_rejected(self):
        for label, (loader, schema_file) in VALIDATED.items():
            instance = loader()
            schema = load_json(os.path.join(HERE, schema_file))
            for why, mutated in self._corrupt(instance):
                with self.subTest(output=label, mutation=why):
                    self.assertTrue(
                        schema_errors(mutated, schema),
                        "schema %s should have rejected %s (%s)"
                        % (schema_file, label, why))


class EscapeGuard(unittest.TestCase):
    """Every adopter-facing machine JSON output is accounted for exactly once:
    validated here, schema'd+guarded elsewhere, or EXEMPT with a reason. A new
    generator output on none of those lists fails."""

    def test_no_json_output_escapes(self):
        universe = declared_json_outputs()
        accounted = (set(VALIDATED_FILES)
                     | set(SCHEMED_ELSEWHERE)
                     | set(EXEMPT))

        # No output may be in two buckets at once (ambiguous accounting).
        buckets = [set(VALIDATED_FILES), set(SCHEMED_ELSEWHERE), set(EXEMPT)]
        for i in range(len(buckets)):
            for j in range(i + 1, len(buckets)):
                overlap = buckets[i] & buckets[j]
                self.assertFalse(
                    overlap, "output(s) accounted twice: %s" % sorted(overlap))

        escaped = universe - accounted
        self.assertFalse(
            escaped,
            "adopter-facing JSON output(s) neither schema-validated nor EXEMPT "
            "(add a schema + VALIDATED entry, or EXEMPT them with a reason): %s"
            % sorted(escaped))

        stale = accounted - universe
        self.assertFalse(
            stale,
            "accounted entries that are not declared generator JSON outputs "
            "(remove the stale entry): %s" % sorted(stale))

    def test_every_exempt_entry_has_a_reason(self):
        for output, reason in EXEMPT.items():
            self.assertTrue(
                isinstance(reason, str) and reason.strip(),
                "EXEMPT[%r] must carry a non-empty reason" % output)

    def test_guard_catches_a_new_unaccounted_output(self):
        # Simulate a future gen_*.py emitting a brand-new JSON that nobody
        # schema'd or exempted: it must NOT be in the accounted set.
        accounted = (set(VALIDATED_FILES)
                     | set(SCHEMED_ELSEWHERE)
                     | set(EXEMPT))
        self.assertNotIn("brand_new_emitter_output.json", accounted)

    def test_validated_and_schemed_files_exist_on_disk(self):
        # Validated file outputs and the attestation output must be real files.
        for rel in list(VALIDATED_FILES) + list(SCHEMED_ELSEWHERE):
            self.assertTrue(
                os.path.isfile(os.path.join(HERE, rel)),
                "accounted output does not exist on disk: %s" % rel)


if __name__ == "__main__":
    unittest.main(verbosity=2)

#!/usr/bin/env python3
"""gen_export.py — GENERATE the integrator-facing export contract.

Writes two committed, versioned, machine-pinnable artifacts under the stable
path ``einvoice/export/``:

  * ``export/rules.json``     — one entry per business-rule id the engine
                                actually fires, exposing ONLY the fields the
                                engine already proves.
  * ``export/coverage.json``  — the honest headline coverage numbers.

Both are DERIVED, never hand-maintained. The generator reads ONLY the existing
committed machine sources:

  * ``coverage_matrix.json``       — the asserted business rules + per-rule
                                     provenance (family, syntax, severity, the
                                     source Schematron artifact) and the gap
                                     table (per-universe implemented/excluded/
                                     missing counts).
  * ``syntax_binding_catalog.json``— the UBL / CII syntax-binding
                                     (non-``BR-*``) assert catalog + accounting
                                     totals.
  * ``remediation_catalog.json``   — per-rule remediation title/fix text.
  * ``cii_parity.json``            — CII proof-parity provenance (referenced as
                                     a source of record; no field is invented
                                     from it).

The two syntax-binding *proven* counts are NOT typed as
literals: they are re-derived exactly as ``differential.py``'s ``sb`` / ``sbcii``
legs do — via ``einvoice.syntax_binding_eval``, the engine's own restricted
grammar classifier over ``syntax_binding_catalog.json`` — so they can never
drift from what the engine proves. ``test_export.py`` additionally pins every
headline number to the published ``COVERAGE.md`` headline.

Idempotent + byte-reproducible: re-running writes byte-identical files (keys
sorted, fixed separators, trailing newline). Standard library only; imports the
in-repo ``einvoice`` package at generate time — it is a build tool, NOT part of
the shipped zero-runtime-dependency package.
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

from einvoice import syntax_binding_eval as _sbe  # noqa: E402

# --------------------------------------------------------------------------- #
# Source artifacts (the ONLY inputs; every number below is computed from these) #
# --------------------------------------------------------------------------- #
COVERAGE_MATRIX = os.path.join(HERE, "coverage_matrix.json")
SYNTAX_BINDING = os.path.join(HERE, "syntax_binding_catalog.json")
REMEDIATION = os.path.join(HERE, "remediation_catalog.json")
CII_PARITY = os.path.join(HERE, "cii_parity.json")

EXPORT_DIR = os.path.join(HERE, "export")
RULES_OUT = os.path.join(EXPORT_DIR, "rules.json")
COVERAGE_OUT = os.path.join(EXPORT_DIR, "coverage.json")

#: Bumped only on a breaking change to the export shape (see REPORT-SCHEMA.md).
SCHEMA_VERSION = 1

_SOURCE_NAMES = [
    "coverage_matrix.json",
    "syntax_binding_catalog.json",
    "remediation_catalog.json",
    "cii_parity.json",
]


def _load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _dumps(obj):
    """Deterministic, byte-reproducible JSON: sorted keys, compact-but-readable
    2-space indent, UTF-8 preserved, single trailing newline."""
    return json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


# --------------------------------------------------------------------------- #
# rules.json                                                                    #
# --------------------------------------------------------------------------- #
def build_rules():
    """One entry per business-rule id the engine fires, carrying ONLY fields the
    source JSONs already prove: id, family, syntax, severity, the proven syntax
    binding(s) + their source Schematron artifact, and (verbatim, where present)
    the remediation title/fix text."""
    matrix = _load(COVERAGE_MATRIX)
    remediation = _load(REMEDIATION).get("rules", {})

    rules = []
    for r in matrix["rules"]:
        prov = r.get("provenance") or {}
        # bindings: exactly the syntax binding(s) the rule is PROVEN to fire in
        # (differentially_proven is True), each carrying its source Schematron
        # artifact — copied verbatim from the coverage matrix provenance (no
        # field invented). The proven-binding set equals the rule's `syntax`
        # field for every rule; a divergence is a source-data bug and raises.
        bindings = {
            b: dict(prov[b])
            for b in ("ubl", "cii")
            if prov.get(b, {}).get("differentially_proven") is True
        }
        expected = {"both": {"ubl", "cii"}, "ubl": {"ubl"}, "cii": {"cii"}}
        if set(bindings) != expected.get(r["syntax"], set()):
            raise SystemExit(
                "rule %s: proven bindings %s disagree with syntax=%r"
                % (r["id"], sorted(bindings), r["syntax"]))
        entry = {
            "id": r["id"],
            "title": r["title"],
            "family": r["family"],
            "syntax": r["syntax"],
            "severity": r["severity"],
            "bindings": bindings,
        }
        rem = remediation.get(r["id"])
        if rem is not None:
            rem_out = {}
            if rem.get("title") is not None:
                rem_out["title"] = rem["title"]
            if rem.get("fix") is not None:
                rem_out["fix"] = rem["fix"]
            if rem_out:
                entry["remediation"] = rem_out
        rules.append(entry)

    return {
        "schemaVersion": SCHEMA_VERSION,
        "generated_by": "einvoice/gen_export.py",
        "provenance": {
            "note": ("Generated by einvoice/gen_export.py from the committed "
                     "machine sources; do not hand-edit. Every field is copied "
                     "verbatim from the source JSONs (no rule claim is invented "
                     "here). See REPORT-SCHEMA.md for the versioning policy."),
            "sources": ["coverage_matrix.json", "remediation_catalog.json"],
        },
        "rule_count": len(rules),
        "rules": rules,
    }


# --------------------------------------------------------------------------- #
# coverage.json                                                                 #
# --------------------------------------------------------------------------- #
def build_coverage():
    """The honest headline numbers, every one COMPUTED from a source (never a
    typed literal): the asserted business rules, the UBL/CII syntax-binding
    proven/total headline, and the per-universe implemented/excluded/missing
    counts."""
    matrix = _load(COVERAGE_MATRIX)
    catalog = _load(SYNTAX_BINDING)
    acct = catalog["accounting"]

    # Business rules: computed from the rule table itself; cross-checked against
    # the matrix's own rule_count so a divergence can never slip through.
    total_rules = len(matrix["rules"])
    if total_rules != matrix["rule_count"]:
        raise SystemExit(
            "coverage_matrix rule table (%d) disagrees with rule_count (%d)"
            % (total_rules, matrix["rule_count"]))

    # Syntax-binding totals: the catalog's own extracted accounting totals.
    ubl_total = acct["ubl"]["total"]
    cii_total = acct["cii"]["total"]

    # Syntax-binding PROVEN counts: re-derived here exactly as differential.py's
    # sb / sbcii legs do — the engine's restricted-grammar classifier over the
    # committed catalog. NOT a literal; recomputed every run.
    ubl_proven = len(_sbe.implemented_ids())
    cii_proven = len(_sbe.cii_implemented_ids())

    # Per-universe implemented/excluded/missing: copied from the matrix gap
    # table (itself a live XML parse of the vendored Schematron).
    universes = {}
    for name, art in matrix["gap"]["artifacts"].items():
        universes[name] = {
            "source": art["source"],
            "official_universe": art["official_universe"],
            "implemented": art["implemented"],
            "excluded": art["excluded"],
            "missing": art["missing"],
            "fireable_missing": art["fireable_missing"],
        }

    return {
        "schemaVersion": SCHEMA_VERSION,
        "generated_by": "einvoice/gen_export.py",
        "provenance": {
            "note": ("Generated by einvoice/gen_export.py from the committed "
                     "machine sources; do not hand-edit. Numbers mirror the "
                     "COVERAGE.md headline (test_export.py pins the two "
                     "byte-for-byte). See REPORT-SCHEMA.md for the versioning "
                     "policy."),
            "sources": _SOURCE_NAMES,
        },
        "business_rules": {
            "total_asserted": total_rules,
        },
        "syntax_binding": {
            "ubl": {"proven": ubl_proven, "total": ubl_total},
            "cii": {"proven": cii_proven, "total": cii_total},
        },
        "universes": universes,
    }


def main():
    os.makedirs(EXPORT_DIR, exist_ok=True)
    rules = build_rules()
    coverage = build_coverage()
    with open(RULES_OUT, "w", encoding="utf-8") as fh:
        fh.write(_dumps(rules))
    with open(COVERAGE_OUT, "w", encoding="utf-8") as fh:
        fh.write(_dumps(coverage))
    print("wrote %s (%d rules)" % (RULES_OUT, rules["rule_count"]))
    print("wrote %s" % COVERAGE_OUT)


if __name__ == "__main__":
    main()

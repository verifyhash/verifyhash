#!/usr/bin/env python3
"""Build the machine-checked CII proof-parity worklist (``cii_parity.json``).

MEASUREMENT ONLY — this script implements no rules and flips no syntax tags.
It answers one question honestly: of the matrix rules that are today proven
only on the UBL leg (``syntax == "ubl"`` in ``coverage_matrix.json``), which
ones does an official vendored CII Schematron artifact actually carry?

Classification per rule, derived exclusively from a REAL XML parse
(:func:`einvoice.coverage.schematron_assert_index` — ``xml.etree``, the
T-VHR.1 method, no regex-over-prose and no hand-transcribed lists):

* ``cii-fireable`` — an ``sch:assert`` with a matching ``@id`` exists in at
  least one vendored CII artifact. These form the real QA worklist: the rule
  officially exists on CII and awaits a differential proof there.
* ``binding-inapplicable`` — no vendored CII artifact carries the id. The
  rule is officially UBL-only at the vendored artifact versions; there is
  nothing to prove against on the CII leg.
* ``cii-artifact-defective`` — a vendored CII artifact carries the id, but
  the SHIPPED assert can never fire (a ``test="true()"`` tautology or a
  row-bound context whose ``every $rate in ()`` is vacuously true). The
  defect is re-verified against a live parse of the artifact on every run
  and the verbatim ``@context``/``@test`` evidence is embedded in the entry
  (see ``ARTIFACT_DEFECTS``); CII parity is impossible until an artifact
  bump fixes the assert — at which point the live verification FAILS and
  the rule rejoins the fireable worklist.

The two CII artifacts read are EXACTLY the ones the existing coverage-gap
tooling reads (single source of truth = ``gen_coverage.py``):

* ``en16931-cii`` — the preprocessed CEN EN 16931 CII Schematron
  (``gen_coverage.GAP_ARTIFACT_SCH``), and
* ``xrechnung-cii`` — the KoSIT XRechnung CII Schematron
  (``gen_coverage.SCHEMATRON_SOURCES``).

When an id appears in both, the sourcing ``cii_artifact`` records the first
hit in that fixed order (CEN before KoSIT — the CEN core artifact is the
canonical universe, the KoSIT layer a national CIUS on top).

Standard library only; no saxonche, no network.

    python3 gen_cii_parity.py            # (re)write cii_parity.json
    python3 gen_cii_parity.py --check    # fail if the committed file is stale

``test_cii_parity.py`` recomputes everything here live and fails on any drift
between the vendored artifacts, the matrix, and the committed JSON.
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

from einvoice import coverage as _coverage  # noqa: E402
import gen_coverage as _gen                  # noqa: E402

JSON_PATH = os.path.join(HERE, "cii_parity.json")

# The vendored CII artifacts, in classification precedence order. Paths are
# NOT restated here — they are read from gen_coverage's own tables so this
# worklist can never diverge from what the gap tooling parses.
CII_ARTIFACT_ORDER = ["en16931-cii", "xrechnung-cii"]
CII_ARTIFACT_SCH = {
    "en16931-cii": _gen.GAP_ARTIFACT_SCH["en16931-cii"],
    "xrechnung-cii": _gen.SCHEMATRON_SOURCES["xrechnung-cii"]["file"],
}

CLASS_FIREABLE = "cii-fireable"
CLASS_INAPPLICABLE = "binding-inapplicable"
CLASS_DEFECTIVE = "cii-artifact-defective"

# Rules whose id IS carried by a vendored CII artifact but whose SHIPPED CII
# assert can never fire — a defect of the official artifact, not a missing
# proof. These leave the cii-fireable worklist with the artifact itself as
# the evidence: build_parity() re-verifies each recorded defect against a
# live parse of the artifact on every run (and test_cii_parity.py again on
# every gate), embedding the VERBATIM rule @context and assert @test into the
# committed entry — so an artifact bump that FIXES a defect makes generation
# fail loudly and reopens the rule as cii-fireable. Two defect kinds exist
# today, both long documented in differential.CII_EXCLUDED_RULE_IDS and
# COVERAGE.md's per-rule notes — this table promotes them into the
# classifier (T-VHCIIP.5):
#
# * ``tautology`` — the assert ships as ``test="true()"``: no document can
#   ever make it fire (BR-AF-09, BR-AG-09).
# * ``row-bound-context`` — the assert is bound to the
#   ``ram:ApplicableTradeTax`` ROW (unlike BR-S-08, whose context node is
#   the ``ram:CategoryCode`` CHILD), so its ``every $rate in
#   ../ram:RateApplicablePercent`` steps to the header settlement — which
#   has no RateApplicablePercent children — and quantifies over the empty
#   sequence: vacuously true, the assert can never fire (BR-AF-08,
#   BR-AG-08).
_DEFECT_NOTE_ROW_BOUND = (
    "assert bound to the ram:ApplicableTradeTax ROW, so "
    "../ram:RateApplicablePercent is empty and 'every $rate in ()' is "
    "vacuously true — the shipped assert can never fire.")
_DEFECT_NOTE_TAUTOLOGY = (
    "the artifact ships this assert as test=\"true()\" — a tautology that "
    "can never fire, whatever the arithmetic.")
ARTIFACT_DEFECTS = {
    "BR-AF-08": {"kind": "row-bound-context", "note": _DEFECT_NOTE_ROW_BOUND},
    "BR-AF-09": {"kind": "tautology", "note": _DEFECT_NOTE_TAUTOLOGY},
    "BR-AG-08": {"kind": "row-bound-context", "note": _DEFECT_NOTE_ROW_BOUND},
    "BR-AG-09": {"kind": "tautology", "note": _DEFECT_NOTE_TAUTOLOGY},
}

_SCH_NS = "{http://purl.oclc.org/dsdl/schematron}"


def cii_assert_context_index(path):
    """``{assert_id: verbatim sch:rule/@context}`` from a real XML parse —
    the evidence surface the row-bound-context defect verification needs
    (``schematron_assert_index`` carries flag/text/test but not the parent
    rule's context). First occurrence wins, like the assert index."""
    import xml.etree.ElementTree as ET
    index = {}
    for rule in ET.parse(os.path.join(HERE, path)).getroot().iter(
            _SCH_NS + "rule"):
        ctx = rule.get("context") or ""
        for a in rule.iter(_SCH_NS + "assert"):
            rid = a.get("id")
            if rid and rid not in index:
                index[rid] = ctx
    return index


def verify_artifact_defect(rid, entry, context):
    """Re-verify a recorded artifact defect against the LIVE parse; returns
    the evidence dict to embed, or raises AssertionError when the artifact no
    longer exhibits the defect (e.g. a fixed upstream release was vendored —
    the rule must then rejoin the cii-fireable worklist)."""
    spec = ARTIFACT_DEFECTS[rid]
    test = entry["test"]
    if spec["kind"] == "tautology":
        assert entry["vacuous_in_artifact"] and test.strip() == "true()", (
            "%s: recorded as a tautology but the vendored artifact's @test "
            "is no longer literally true() — the defect was fixed upstream; "
            "remove it from ARTIFACT_DEFECTS and differentially prove the "
            "rule instead (@test=%r)" % (rid, test[:120]))
    else:  # row-bound-context
        last_step = context.split("[", 1)[0].rstrip("/").rsplit("/", 1)[-1]
        assert last_step == "ram:ApplicableTradeTax", (
            "%s: recorded as row-bound-context but the vendored artifact's "
            "rule context no longer ends at the ram:ApplicableTradeTax row — "
            "the defect was fixed upstream; remove it from ARTIFACT_DEFECTS "
            "and differentially prove the rule instead (context=%r)"
            % (rid, context))
        assert test.startswith("every $rate in ../ram:RateApplicablePercent"), (
            "%s: recorded as row-bound-context but the assert no longer "
            "quantifies over ../ram:RateApplicablePercent (@test=%r)"
            % (rid, test[:120]))
    return {
        "kind": spec["kind"],
        "context": context,
        "test": test,
        "note": spec["note"],
    }


def cii_assert_indexes():
    """Fresh ``{artifact_key: {assert_id: entry}}`` from a real XML parse of
    each vendored CII Schematron artifact."""
    return {
        key: _coverage.schematron_assert_index(
            os.path.join(HERE, CII_ARTIFACT_SCH[key]))
        for key in CII_ARTIFACT_ORDER
    }


def ubl_only_rules(matrix=None):
    """The matrix rules currently proven on the UBL leg only, as committed."""
    if matrix is None:
        matrix = _coverage.load_matrix()
    return [r for r in matrix["rules"] if r.get("syntax") == "ubl"]


def build_parity(matrix=None, indexes=None):
    """Compute the full parity document from live sources.

    Deterministic: one entry per ``syntax == "ubl"`` matrix rule, sorted by
    id, each classified purely by ``@id`` membership in the parsed artifact
    assert indexes — except the ARTIFACT_DEFECTS rules, whose carried-but-
    unfireable CII asserts are re-verified live and embedded verbatim as
    ``artifact_evidence`` (see the table's docstring above).
    """
    if indexes is None:
        indexes = cii_assert_indexes()
    context_cache = {}
    entries = []
    for rule in ubl_only_rules(matrix):
        rid = rule["id"]
        artifact = None
        artifact_key = None
        for key in CII_ARTIFACT_ORDER:
            if rid in indexes[key]:
                artifact = CII_ARTIFACT_SCH[key]
                artifact_key = key
                break
        if artifact and rid in ARTIFACT_DEFECTS:
            if artifact_key not in context_cache:
                context_cache[artifact_key] = cii_assert_context_index(
                    artifact)
            entries.append({
                "id": rid,
                "family": rule["family"],
                "classification": CLASS_DEFECTIVE,
                "cii_artifact": artifact,
                "artifact_evidence": verify_artifact_defect(
                    rid, indexes[artifact_key][rid],
                    context_cache[artifact_key].get(rid, "")),
            })
            continue
        entries.append({
            "id": rid,
            "family": rule["family"],
            "classification": (CLASS_FIREABLE if artifact
                               else CLASS_INAPPLICABLE),
            "cii_artifact": artifact,
        })
    entries.sort(key=lambda e: e["id"])
    return {
        "generated_from": [CII_ARTIFACT_SCH[key] for key in CII_ARTIFACT_ORDER],
        "rules": entries,
    }


def render_json(doc):
    """Canonical committed serialization (stable, diff-friendly)."""
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def main(argv):
    doc = build_parity()
    text = render_json(doc)
    if "--check" in argv:
        try:
            with open(JSON_PATH, encoding="utf-8") as fh:
                committed = fh.read()
        except FileNotFoundError:
            committed = None
        if committed != text:
            sys.stderr.write("cii_parity.json is STALE — re-run "
                             "gen_cii_parity.py\n")
            return 1
        print("cii_parity.json is fresh.")
        return 0
    with open(JSON_PATH, "w", encoding="utf-8") as fh:
        fh.write(text)
    n = len(doc["rules"])
    n_fire = sum(1 for e in doc["rules"]
                 if e["classification"] == CLASS_FIREABLE)
    n_defect = sum(1 for e in doc["rules"]
                   if e["classification"] == CLASS_DEFECTIVE)
    print("wrote cii_parity.json: %d UBL-only-proven rules — %d %s, %d %s, "
          "%d %s"
          % (n, n_fire, CLASS_FIREABLE, n_defect, CLASS_DEFECTIVE,
             n - n_fire - n_defect, CLASS_INAPPLICABLE))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

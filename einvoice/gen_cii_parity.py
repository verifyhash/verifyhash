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
    assert indexes.
    """
    if indexes is None:
        indexes = cii_assert_indexes()
    entries = []
    for rule in ubl_only_rules(matrix):
        rid = rule["id"]
        artifact = None
        for key in CII_ARTIFACT_ORDER:
            if rid in indexes[key]:
                artifact = CII_ARTIFACT_SCH[key]
                break
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
    print("wrote cii_parity.json: %d UBL-only-proven rules — %d %s, %d %s"
          % (n, n_fire, CLASS_FIREABLE, n - n_fire, CLASS_INAPPLICABLE))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

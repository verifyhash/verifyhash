#!/usr/bin/env python3
"""test_coverage_matrix.py — the published coverage matrix must reflect exactly
what the engine fires, and COVERAGE.md must be a byte-identical render of it.

Standard library only; no network. Run:

    python3 test_coverage_matrix.py

Checks (each an independent hard assert):

  1. coverage_matrix.json's rule-id set EXACTLY equals the set of ids the engine
     can fire — enumerated PROGRAMMATICALLY off the live registries
     (einvoice.rules.ALL_RULES + einvoice.rules_xrechnung.ALL_RULES +
     einvoice.rules_xrechnung.CII_DE_RULES), never a hand-copied list. Fails on
     any rule claimed-but-absent from code OR asserted-in-code-but-undocumented.
  2. every entry has a non-empty syntax in {ubl,cii,both}, severity in
     {fatal,warning}, a raw flag, and a provenance object.
  3. each entry's severity/flag matches the engine's real severity, and its
     syntax matches the differentially-proven graded sets (differential.py) — so
     coverage cannot be fabricated (e.g. claiming CII proof we do not have).
  4. COVERAGE.md is byte-for-byte identical to an in-memory re-render from the
     committed JSON (drift guard).
  5. the exclusions section names the vacuous rules, and none of them are in the
     fireable set (an excluded rule must not also be claimed as coverage).
"""

from __future__ import annotations

import inspect
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

from einvoice import rules as _rules              # noqa: E402
from einvoice import rules_xrechnung as _rules_xr  # noqa: E402
from einvoice import coverage as _coverage         # noqa: E402
import differential as _diff                        # noqa: E402

JSON_PATH = os.path.join(HERE, "coverage_matrix.json")
MD_PATH = os.path.join(HERE, "COVERAGE.md")


def _engine_fireable_ids():
    """The exact fireable set, enumerated independently of coverage.py so this
    test does not merely re-check the helper against itself."""
    core = set()
    for fn in _rules.ALL_RULES:
        head = (fn.__doc__ or "").strip().split(":", 1)[0].strip()
        assert head.startswith("BR-"), (fn.__name__, head)
        core.add(head)
    ubl_de = {fn.rule_id for fn in _rules_xr.ALL_RULES}
    cii_de = {fn.rule_id for fn in _rules_xr.CII_DE_RULES}
    return core | ubl_de | cii_de


def _engine_severity_and_flag():
    """id -> (severity_class, raw_flag) straight off the engine."""
    out = {}
    for fn in _rules.ALL_RULES:
        rid = (fn.__doc__ or "").strip().split(":", 1)[0].strip()
        src = inspect.getsource(fn)
        if re.search(r'["\']information["\']', src):
            flag = "information"
        elif re.search(r',\s*["\']warning["\']\s*\)', src):
            flag = "warning"
        else:
            flag = "fatal"
        out[rid] = ("fatal" if flag == "fatal" else "warning", flag)
    for fn in _rules_xr.ALL_RULES:
        flag = fn.severity
        out[fn.rule_id] = ("fatal" if flag == "fatal" else "warning", flag)
    return out


def _proven_syntax(rid):
    """The syntax tag the differential graded sets justify for ``rid``."""
    core_cii = set(_diff.CII_RULE_SET)
    de_cii = set(_diff.CII_XR_RULE_SET)
    return "both" if (rid in core_cii or rid in de_cii) else "ubl"


def main():
    failures = []

    def check(cond, msg):
        if not cond:
            failures.append(msg)

    # Load the committed artifacts.
    assert os.path.exists(JSON_PATH), "coverage_matrix.json missing"
    assert os.path.exists(MD_PATH), "COVERAGE.md missing"
    matrix = _coverage.load_matrix(JSON_PATH)

    # ---- 1. id set EXACTLY equals the engine's fireable set ---------------
    engine_ids = _engine_fireable_ids()
    matrix_ids = _coverage.matrix_rule_ids(matrix)
    claimed_absent = sorted(matrix_ids - engine_ids)
    asserted_undocumented = sorted(engine_ids - matrix_ids)
    check(not claimed_absent,
          "matrix claims rules the engine does NOT fire: %s" % claimed_absent)
    check(not asserted_undocumented,
          "engine fires rules the matrix does NOT document: %s"
          % asserted_undocumented)
    # No duplicate ids in the matrix.
    ids_list = [r["id"] for r in matrix["rules"]]
    dups = sorted({x for x in ids_list if ids_list.count(x) > 1})
    check(not dups, "duplicate rule ids in matrix: %s" % dups)

    # ---- 2. per-entry field validity -------------------------------------
    for r in matrix["rules"]:
        rid = r.get("id")
        check(bool(rid), "entry with empty id: %r" % r)
        check(r.get("syntax") in ("ubl", "cii", "both"),
              "%s: bad syntax %r" % (rid, r.get("syntax")))
        check(r.get("severity") in ("fatal", "warning"),
              "%s: bad severity %r" % (rid, r.get("severity")))
        check(bool(r.get("flag")), "%s: empty flag" % rid)
        prov = r.get("provenance")
        check(prov is not None and isinstance(prov, dict) and bool(prov),
              "%s: empty/absent provenance" % rid)
        check(bool(r.get("title")), "%s: empty title" % rid)

    # ---- 3. severity/flag/syntax honesty vs the engine -------------------
    eng = _engine_severity_and_flag()
    for r in matrix["rules"]:
        rid = r["id"]
        exp_sev, exp_flag = eng[rid]
        check(r["severity"] == exp_sev,
              "%s: severity %r != engine %r" % (rid, r["severity"], exp_sev))
        check(r["flag"] == exp_flag,
              "%s: flag %r != engine %r" % (rid, r["flag"], exp_flag))
        exp_syntax = _proven_syntax(rid)
        check(r["syntax"] == exp_syntax,
              "%s: syntax %r != differentially-proven %r"
              % (rid, r["syntax"], exp_syntax))
        # A 'both' rule must carry a proven CII provenance; 'ubl' must not claim it.
        cii_prov = (r.get("provenance") or {}).get("cii") or {}
        cii_proven = bool(cii_prov.get("differentially_proven"))
        check(cii_proven == (r["syntax"] == "both"),
              "%s: CII provenance proven=%s but syntax=%s"
              % (rid, cii_proven, r["syntax"]))
        # An unproven syntax must honestly say why.
        if not cii_proven:
            check(bool(cii_prov.get("reason")),
                  "%s: unproven CII provenance lacks a reason" % rid)

    # ---- 4. COVERAGE.md is a byte-identical render of the JSON -----------
    rendered = _coverage.render_markdown(matrix)
    committed = open(MD_PATH, encoding="utf-8").read()
    check(rendered == committed,
          "COVERAGE.md is stale: it is not a byte-identical render of "
          "coverage_matrix.json (re-run gen_coverage.py). first diff at offset %s"
          % _first_diff(rendered, committed))

    # ---- 5. exclusions: vacuous rules present and NOT in the fireable set -
    exc = matrix.get("exclusions") or {}
    vacuous_ids = {e["id"] for e in exc.get("vacuous", [])}
    check(vacuous_ids >= {"BR-DEC-13", "BR-DEC-15"},
          "exclusions.vacuous must list BR-DEC-13 and BR-DEC-15; got %s"
          % sorted(vacuous_ids))
    overlap = sorted(vacuous_ids & engine_ids)
    check(not overlap,
          "a vacuous/excluded rule is ALSO claimed as fired coverage: %s" % overlap)
    check("peppol" in exc, "exclusions must document Peppol scope (T-VH.17)")

    # ---- report ----------------------------------------------------------
    if failures:
        sys.stderr.write("COVERAGE MATRIX TEST: FAIL (%d)\n" % len(failures))
        for m in failures:
            sys.stderr.write("  !! " + m + "\n")
        return 1
    print("coverage matrix OK: %d rules, id-set == engine fireable set, "
          "severities/flags/syntax match the engine, COVERAGE.md byte-identical, "
          "exclusions honest." % len(matrix["rules"]))
    return 0


def _first_diff(a, b):
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            return "%d (%r vs %r)" % (i, a[max(0, i - 20):i + 20],
                                      b[max(0, i - 20):i + 20])
    return "len %d vs %d" % (len(a), len(b))


if __name__ == "__main__":
    sys.exit(main())

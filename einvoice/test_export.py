#!/usr/bin/env python3
"""test_export.py — the committed integrator export contract must be a faithful,
non-drifting, generated projection of the engine's proven coverage.

Standard library only; no network. Run:

    python3 test_export.py

Checks (each an independent hard assert; mirrors the ACCEPTANCE CRITERIA):

  (a) BYTE-REPRODUCIBILITY / no hand-edit — regenerating both export files (via
      gen_export.py's builders, written to a temp dir) yields bytes identical to
      the committed export/rules.json + export/coverage.json.
  (b) SHAPE — both files parse as JSON and carry a non-empty top-level
      schemaVersion; rules.json is non-empty and EVERY entry carries the
      required fields id / family / syntax / severity / bindings (with a source
      Schematron artifact per binding).
  (c) HEADLINE PARITY — coverage.json's 286 / 741 / 756 / 546 / 583 headline
      counts EQUAL the numbers parsed from COVERAGE.md, so the export can never
      silently diverge from the published headline.
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

import gen_export as _gx  # noqa: E402

RULES_PATH = os.path.join(HERE, "export", "rules.json")
COVERAGE_PATH = os.path.join(HERE, "export", "coverage.json")
COVERAGE_MD = os.path.join(HERE, "COVERAGE.md")


def _read_bytes(path):
    with open(path, "rb") as fh:
        return fh.read()


def _parse_coverage_md_headline():
    """The published headline counts, parsed straight from COVERAGE.md:
    (business_rules, ubl_proven, ubl_total, cii_proven, cii_total)."""
    text = open(COVERAGE_MD, encoding="utf-8").read()
    m_rules = re.search(r"\*\*(\d+) business rules\*\*", text)
    m_sb = re.search(
        r"\*\*(\d+) of (\d+) UBL\*\* \+ \*\*(\d+) of (\d+) CII\*\*", text)
    if not m_rules or not m_sb:
        return None
    return {
        "business_rules": int(m_rules.group(1)),
        "ubl_proven": int(m_sb.group(1)),
        "ubl_total": int(m_sb.group(2)),
        "cii_proven": int(m_sb.group(3)),
        "cii_total": int(m_sb.group(4)),
    }


def main():
    failures = []

    def check(cond, msg):
        if not cond:
            failures.append(msg)

    # ---- (a) byte-reproducibility (no drift, no hand-edit) ---------------
    committed_rules = _read_bytes(RULES_PATH)
    committed_cov = _read_bytes(COVERAGE_PATH)
    regen_rules = _gx._dumps(_gx.build_rules()).encode("utf-8")
    regen_cov = _gx._dumps(_gx.build_coverage()).encode("utf-8")
    check(regen_rules == committed_rules,
          "export/rules.json is not byte-identical to a fresh gen_export.py "
          "run (drift or hand-edit)")
    check(regen_cov == committed_cov,
          "export/coverage.json is not byte-identical to a fresh gen_export.py "
          "run (drift or hand-edit)")

    # Also exercise main() end-to-end into a temp dir and confirm the emitted
    # bytes match the committed files (proves the writer path, not just builders).
    with tempfile.TemporaryDirectory() as td:
        real_dir, real_rules, real_cov = (
            _gx.EXPORT_DIR, _gx.RULES_OUT, _gx.COVERAGE_OUT)
        try:
            _gx.EXPORT_DIR = td
            _gx.RULES_OUT = os.path.join(td, "rules.json")
            _gx.COVERAGE_OUT = os.path.join(td, "coverage.json")
            _sink = io.StringIO()
            _stdout = sys.stdout
            try:
                sys.stdout = _sink
                _gx.main()
            finally:
                sys.stdout = _stdout
            check(_read_bytes(_gx.RULES_OUT) == committed_rules,
                  "gen_export.main() rules.json output differs from committed")
            check(_read_bytes(_gx.COVERAGE_OUT) == committed_cov,
                  "gen_export.main() coverage.json output differs from committed")
        finally:
            _gx.EXPORT_DIR, _gx.RULES_OUT, _gx.COVERAGE_OUT = (
                real_dir, real_rules, real_cov)

    # ---- (b) shape + schemaVersion + required per-rule fields ------------
    rules_doc = json.loads(committed_rules.decode("utf-8"))
    cov_doc = json.loads(committed_cov.decode("utf-8"))

    check(bool(rules_doc.get("schemaVersion")),
          "rules.json: schemaVersion missing/empty")
    check(bool(cov_doc.get("schemaVersion")),
          "coverage.json: schemaVersion missing/empty")

    rules = rules_doc.get("rules")
    check(isinstance(rules, list) and len(rules) > 0,
          "rules.json: rules list missing or empty")
    if isinstance(rules, list):
        for e in rules:
            rid = e.get("id")
            check(isinstance(rid, str) and rid, "a rule entry has no id")
            for field in ("family", "syntax", "severity"):
                check(isinstance(e.get(field), str) and e.get(field),
                      "%s: required field %r missing/empty" % (rid, field))
            check(e.get("severity") in ("fatal", "warning"),
                  "%s: severity %r not fatal/warning" % (rid, e.get("severity")))
            bindings = e.get("bindings")
            check(isinstance(bindings, dict) and len(bindings) > 0,
                  "%s: bindings missing or empty (no proven syntax binding)"
                  % rid)
            if isinstance(bindings, dict):
                for bkey, bval in bindings.items():
                    check(bkey in ("ubl", "cii"),
                          "%s: unexpected binding key %r" % (rid, bkey))
                    check(isinstance(bval, dict)
                          and isinstance(bval.get("sch"), str)
                          and bval.get("sch"),
                          "%s: binding %r has no source Schematron artifact "
                          "(sch)" % (rid, bkey))

    # ---- (c) coverage.json headline == COVERAGE.md headline --------------
    md = _parse_coverage_md_headline()
    check(md is not None, "could not parse the COVERAGE.md headline counts")
    if md is not None:
        sb = cov_doc["syntax_binding"]
        comparisons = [
            ("business_rules.total_asserted",
             cov_doc["business_rules"]["total_asserted"], md["business_rules"]),
            ("syntax_binding.ubl.proven", sb["ubl"]["proven"], md["ubl_proven"]),
            ("syntax_binding.ubl.total", sb["ubl"]["total"], md["ubl_total"]),
            ("syntax_binding.cii.proven", sb["cii"]["proven"], md["cii_proven"]),
            ("syntax_binding.cii.total", sb["cii"]["total"], md["cii_total"]),
        ]
        for name, got, want in comparisons:
            check(got == want,
                  "coverage.json %s = %r but COVERAGE.md headline says %r"
                  % (name, got, want))
        # Belt-and-suspenders: the exact published quintet.
        check((md["business_rules"], md["ubl_proven"], md["ubl_total"],
               md["cii_proven"], md["cii_total"]) == (286, 741, 756, 546, 583),
              "COVERAGE.md headline is no longer 286 / 741 of 756 / 546 of 583 "
              "— update the export test if the engine's coverage genuinely moved")

    # ---- report ----------------------------------------------------------
    if failures:
        sys.stderr.write("EXPORT CONTRACT TEST: FAIL (%d)\n" % len(failures))
        for m in failures:
            sys.stderr.write("  !! " + m + "\n")
        return 1
    print("export contract OK: %d rules, byte-reproducible, schemaVersion "
          "pinned, coverage headline == COVERAGE.md (286 / 741 of 756 UBL / "
          "546 of 583 CII)." % len(rules))
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""test_syntax_binding.py — the committed syntax_binding_catalog.json must be a
FRESH, id-for-id re-extraction of the syntax-binding (non-``BR-*``) asserts from
the two vendored preprocessed CEN Schematron artifacts, and the headline counts
must hold.

Standard library only (``xml.etree`` + ``json``); no saxonche, no network. Run:

    python3 test_syntax_binding.py

What is checked (each an independent hard assert; non-zero exit on any failure):

  1. INDEPENDENT re-parse: a second, self-contained XML parse of both vendored
     ``.sch`` files (NOT via einvoice.syntax_binding) recomputes the non-BR
     assert id set. Totals must be UBL == 756 and CII == 583, with the exact
     prefix breakdown (678 UBL-CR / 24 UBL-DT / 54 UBL-SR; 101 CII-DT /
     482 CII-SR). An artifact bump that changes the population fails here.
  2. catalog == fresh extraction, id-for-id: the committed catalog's entry list
     is byte-equal (field for field, in document order) to a fresh
     einvoice.syntax_binding.extract_all() — so catalog drift or an artifact
     bump fails the gate.
  3. every catalog entry carries id / binding / context / test / flag / shape,
     with a valid binding and a known shape class, and NO ``BR-*`` id leaks in
     (this catalog is deliberately disjoint from the business-rule matrix).
  4. the committed accounting (histogram + prefix counts) equals a live
     recomputation from the artifacts.
"""

from __future__ import annotations

import json
import os
import re
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

from einvoice import syntax_binding as _sb  # noqa: E402

CATALOG_PATH = os.path.join(HERE, "syntax_binding_catalog.json")
_SCH_NS = "{http://purl.oclc.org/dsdl/schematron}"

EXPECTED_TOTALS = {"ubl": 756, "cii": 583}
EXPECTED_PREFIX = {
    "ubl": {"UBL-CR": 678, "UBL-DT": 24, "UBL-SR": 54},
    "cii": {"CII-DT": 101, "CII-SR": 482},
}
_NONBR_RE = {
    "ubl": re.compile(r"^UBL-(?:CR|DT|SR)-\d+$"),
    "cii": re.compile(r"^CII-(?:DT|SR)-\d+$"),
}


def _independent_parse(binding):
    """Self-contained re-parse of one artifact — deliberately NOT routed through
    einvoice.syntax_binding, so this test does not merely re-check the module
    against itself. Returns the ordered list of (id, context, test, flag) for
    every non-BR assert."""
    path = _sb.artifact_path(binding, HERE)
    id_re = _NONBR_RE[binding]
    out = []
    for rule in ET.parse(path).getroot().iter(_SCH_NS + "rule"):
        context = rule.get("context") or ""
        for a in rule.findall(_SCH_NS + "assert"):
            rid = a.get("id") or ""
            if id_re.match(rid):
                out.append((rid, context, a.get("test") or "",
                            a.get("flag") or "fatal"))
    return out


def main():
    failures = []

    def check(cond, msg):
        if not cond:
            failures.append(msg)

    assert os.path.exists(CATALOG_PATH), "syntax_binding_catalog.json missing"
    catalog = json.load(open(CATALOG_PATH, encoding="utf-8"))
    entries = catalog.get("entries") or []

    # ---- 1. INDEPENDENT re-parse: totals + prefix breakdown ---------------
    indep = {b: _independent_parse(b) for b in ("ubl", "cii")}
    for b in ("ubl", "cii"):
        total = len(indep[b])
        check(total == EXPECTED_TOTALS[b],
              "%s total: re-parsed %d, expected %d"
              % (b, total, EXPECTED_TOTALS[b]))
        prefix = {}
        for rid, _, _, _ in indep[b]:
            p = rid.rsplit("-", 1)[0]
            prefix[p] = prefix.get(p, 0) + 1
        check(prefix == EXPECTED_PREFIX[b],
              "%s prefix breakdown: re-parsed %s, expected %s"
              % (b, prefix, EXPECTED_PREFIX[b]))

    # ---- 2. committed catalog == fresh extraction, id-for-id --------------
    fresh = _sb.extract_all(HERE)
    fresh_entries = fresh["ubl"] + fresh["cii"]
    check(len(entries) == len(fresh_entries),
          "catalog has %d entries, fresh extraction has %d"
          % (len(entries), len(fresh_entries)))
    if len(entries) == len(fresh_entries):
        for i, (got, exp) in enumerate(zip(entries, fresh_entries)):
            if got != exp:
                check(False, "catalog entry %d drifted from fresh extraction: "
                             "%r vs %r" % (i, got, exp))
                break

    # Cross-check: the catalog ids/contexts/tests/flags also equal the
    # INDEPENDENT parse (module and independent parse must agree).
    indep_flat = [(rid, ctx, test, flag)
                  for b in ("ubl", "cii")
                  for (rid, ctx, test, flag) in indep[b]]
    cat_flat = [(e.get("id"), e.get("context"), e.get("test"), e.get("flag"))
                for e in entries]
    check(indep_flat == cat_flat,
          "catalog (id,context,test,flag) tuples do not match the independent "
          "re-parse of the vendored artifacts")

    # ---- 3. per-entry fields + no BR-* leakage ----------------------------
    required = ("id", "binding", "context", "test", "flag", "shape")
    for e in entries:
        rid = e.get("id")
        missing = [f for f in required if f not in e]
        check(not missing, "entry %r missing fields %s" % (rid, missing))
        check(e.get("binding") in ("ubl", "cii"),
              "entry %r bad binding %r" % (rid, e.get("binding")))
        check(e.get("shape") in _sb.SHAPE_CLASSES,
              "entry %r bad shape %r" % (rid, e.get("shape")))
        check(bool(e.get("flag")), "entry %r empty flag" % rid)
        check(rid and not rid.startswith("BR-"),
              "a BR-* business rule leaked into the syntax-binding catalog: %r"
              % rid)

    # ---- 4. committed accounting == live recomputation --------------------
    live_acct = _sb.accounting(HERE)
    check(catalog.get("accounting") == live_acct,
          "committed accounting (histogram/prefix) is stale vs a live "
          "recomputation from the artifacts")

    # ---- report -----------------------------------------------------------
    if failures:
        sys.stderr.write("SYNTAX-BINDING TEST: FAIL (%d)\n" % len(failures))
        for m in failures:
            sys.stderr.write("  !! " + m + "\n")
        return 1
    print("syntax-binding catalog OK: UBL %d + CII %d = %d non-BR asserts, "
          "catalog == fresh extraction id-for-id, all entries carry "
          "id/binding/context/test/flag/shape, accounting live-consistent."
          % (EXPECTED_TOTALS["ubl"], EXPECTED_TOTALS["cii"],
             EXPECTED_TOTALS["ubl"] + EXPECTED_TOTALS["cii"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())

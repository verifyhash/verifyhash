#!/usr/bin/env python3
"""test_known_open_audit.py — the committed ``known_open_audit.json``
(T-VHCOV.1, the MEASURE-ONLY terminal audit of the coverage remainder) must
stay in exact lockstep with the LIVE known-open set.

Standard library only; no saxonche, no network. Run:

    python3 test_known_open_audit.py

What is checked (each an independent hard assert; non-zero exit on any failure):

  1. ID SET, no drift in EITHER direction: the audit's id set exactly equals
     the live known-open set recomputed via the SAME module APIs
     ``test_syntax_binding.py`` asserts against (``known_open_ids()`` /
     ``class_known_open_ids`` / ``cii_class_known_open_ids``) — an id missing
     from the audit fails, and a stale audit id no longer live fails. The
     per-binding totals are pinned (15 UBL + 37 CII).
  2. every entry's ``class`` is one of the three allowed blocker classes, and
     the committed ``counts`` equal a live recount of the entries.
  3. every entry carries a non-empty ``test`` / ``context`` / ``reason``, its
     ``binding``/``shape_class`` match the live partition, and the recorded
     @test/@context are VERBATIM the committed catalog's (exactness — never a
     paraphrase).
  4. deterministic ordering: entries are sorted by (binding, id), so
     regeneration (``gen_known_open_audit.py``) is byte-stable.
  5. the machine-listed rule-family known-open universes of
     ``coverage_matrix.json`` (peppol_kosit_family / cvd_tmp_family
     known_open_worklist, creditnote_conformance known_open) are recorded in
     the audit — as EMPTY universes today; if any grows an entry, this test
     fails until the audit classifies it.
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

from einvoice import syntax_binding_eval as _sbe  # noqa: E402

AUDIT_PATH = os.path.join(HERE, "known_open_audit.json")
CATALOG_PATH = os.path.join(HERE, "syntax_binding_catalog.json")
MATRIX_PATH = os.path.join(HERE, "coverage_matrix.json")

ALLOWED_CLASSES = ("needs-general-xpath", "needs-external-codelist",
                   "promotable-under-provable-extension")
EXPECTED_TOTALS = {"UBL": 15, "CII": 37}


def _live_known_open():
    """(id -> (binding, shape_class)) recomputed via the SAME module APIs
    test_syntax_binding.py uses — never a hardcoded roster."""
    _sbe.reset_cache()
    live = {}
    for rid in _sbe.known_open_ids():
        live[rid] = ("UBL", "absence-restriction")
    for shape in _sbe.NEW_CLASSES:
        for rid in _sbe.class_known_open_ids(shape):
            live[rid] = ("UBL", shape)
    for shape in _sbe.CII_SHAPE_CLASSES:
        for rid in _sbe.cii_class_known_open_ids(shape):
            live[rid] = ("CII", shape)
    return live


def main():
    failures = []

    def check(cond, msg):
        if not cond:
            failures.append(msg)

    assert os.path.exists(AUDIT_PATH), "known_open_audit.json missing"
    audit = json.load(open(AUDIT_PATH, encoding="utf-8"))
    entries = audit.get("entries") or []
    catalog = json.load(open(CATALOG_PATH, encoding="utf-8"))
    cat_by_id = {e["id"]: e for e in catalog.get("entries", [])}

    # ---- 1. id set == live known-open set, no drift in either direction ----
    live = _live_known_open()
    audit_ids = [e.get("id") for e in entries]
    check(len(audit_ids) == len(set(audit_ids)),
          "duplicate ids in the audit: %s"
          % sorted(i for i in set(audit_ids) if audit_ids.count(i) > 1))
    missing = sorted(set(live) - set(audit_ids))
    stale = sorted(set(audit_ids) - set(live))
    check(not missing,
          "live known-open ids MISSING from the audit: %s" % missing)
    check(not stale,
          "audit ids no longer live known-open (stale): %s" % stale)
    per_binding = {}
    for rid in live:
        b = live[rid][0]
        per_binding[b] = per_binding.get(b, 0) + 1
    check(per_binding == EXPECTED_TOTALS,
          "live known-open totals %s != expected %s (frozen headline moved?)"
          % (per_binding, EXPECTED_TOTALS))

    # ---- 2. classes valid + committed counts == live recount ---------------
    recount = {c: 0 for c in ALLOWED_CLASSES}
    for e in entries:
        cls = e.get("class")
        check(cls in ALLOWED_CLASSES,
              "entry %r has invalid class %r" % (e.get("id"), cls))
        if cls in recount:
            recount[cls] += 1
    counts = audit.get("counts")
    check(counts == recount,
          "committed counts %s != live recount of the entries %s"
          % (counts, recount))

    # ---- 3. per-entry fields: non-empty, live-consistent, catalog-verbatim -
    for e in entries:
        rid = e.get("id")
        check(bool(e.get("test")), "entry %r has empty @test" % rid)
        check(bool(e.get("context")), "entry %r has empty @context" % rid)
        check(bool(e.get("reason")), "entry %r has empty reason" % rid)
        if rid in live:
            b, shape = live[rid]
            check(e.get("binding") == b,
                  "entry %r binding %r != live %r" % (rid, e.get("binding"), b))
            check(e.get("shape_class") == shape,
                  "entry %r shape_class %r != live %r"
                  % (rid, e.get("shape_class"), shape))
        cat_e = cat_by_id.get(rid)
        check(cat_e is not None, "entry %r not in the committed catalog" % rid)
        if cat_e is not None:
            check(e.get("test") == cat_e["test"],
                  "entry %r @test is not verbatim the catalog's" % rid)
            check(e.get("context") == cat_e["context"],
                  "entry %r @context is not verbatim the catalog's" % rid)

    # ---- 4. deterministic ordering: sorted by (binding, id) ----------------
    keys = [(e.get("binding") or "", e.get("id") or "") for e in entries]
    check(keys == sorted(keys),
          "entries are not sorted by (binding, id) — regeneration would not "
          "be byte-stable")
    check(bool(audit.get("generated_from")),
          "audit is missing its generated_from sha")

    # ---- 5. rule-family known-open universes recorded (empty, not omitted) -
    matrix = json.load(open(MATRIX_PATH, encoding="utf-8"))
    fam = audit.get("rule_family_known_open") or {}
    for name, key in (("peppol_kosit_family", "known_open_worklist"),
                      ("cvd_tmp_family", "known_open_worklist"),
                      ("creditnote_conformance", "known_open")):
        check(name in fam,
              "rule family %r omitted from the audit (empty universes must be "
              "recorded, not dropped)" % name)
        live_vals = matrix[name][key]
        got = (fam.get(name) or {}).get(key)
        check(got == live_vals,
              "audit's %s.%s %r != coverage_matrix.json's %r"
              % (name, key, got, live_vals))
        check(not live_vals,
              "rule family %r now has known-open entries %r — the audit must "
              "classify them (regenerate)" % (name, live_vals))

    if failures:
        print("test_known_open_audit: %d FAILURE(S)" % len(failures))
        for f in failures:
            print("  - %s" % f)
        return 1
    print("test_known_open_audit: OK — %d entries in lockstep with the live "
          "known-open set (%d UBL + %d CII); counts %s"
          % (len(entries), EXPECTED_TOTALS["UBL"], EXPECTED_TOTALS["CII"],
             json.dumps(audit.get("counts"), sort_keys=True)))
    return 0


if __name__ == "__main__":
    sys.exit(main())

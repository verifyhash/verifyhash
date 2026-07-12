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
  5. IMPLEMENTATION accounting (the T-VHSBL.2 evaluator): the UBL
     ``absence-restriction`` class partitions LIVE into implemented +
     known-open with implemented + known-open == the class total; the
     implemented count is recomputed (not asserted as a magic literal beyond a
     floor); every implemented id is in the differential leg's graded set
     (``differential.SB_RULE_IDS``) so it is differential-covered; and the
     known-open remainder equals EXACTLY the machine-listed worklist in
     COVERAGE.md (so a regression reopens the worklist automatically).
  6. FIRING (saxon-free): each committed targeted fixture
     (corpus/vendored/syntax-binding/) makes its named implemented assert fire
     (violating) or clear (passing), and every finding carries the distinct
     ``syntax-binding`` category with an @flag-mirroring severity.
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
from einvoice import syntax_binding_eval as _sbe  # noqa: E402
from einvoice.parser import parse_file  # noqa: E402
import differential as _diff  # noqa: E402  (import-only; no saxon at import time)

CATALOG_PATH = os.path.join(HERE, "syntax_binding_catalog.json")
COVERAGE_PATH = os.path.join(HERE, "COVERAGE.md")
SB_FIXTURE_DIR = os.path.join(HERE, "corpus", "vendored", "syntax-binding")
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


def _coverage_known_open_ids():
    """The set of ids machine-listed in COVERAGE.md's UBL absence-restriction
    'Known-open worklist' table — parsed straight from the rendered doc, so the
    test proves code and doc name the SAME remainder."""
    if not os.path.exists(COVERAGE_PATH):
        return None
    text = open(COVERAGE_PATH, encoding="utf-8").read()
    # Anchor on the UBL absence-restriction subsection specifically (there are
    # other 'Known-open worklist' headers for the CVD/TMP families above).
    anchor = text.find("### UBL absence-restriction — implemented vs known-open")
    if anchor < 0:
        return set()
    marker = "Known-open worklist (machine-listed"
    i = text.find(marker, anchor)
    if i < 0:
        return set()
    ids = set()
    for line in text[i:].splitlines():
        s = line.strip()
        if s.startswith("| `") and "` |" in s:
            m = re.match(r"^\|\s*`([^`]+)`", s)
            if m:
                ids.add(m.group(1))
        elif s.startswith("### ") and ids:
            break  # next section — stop
    return ids


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

    # ---- 5. IMPLEMENTATION accounting (live recompute + differential cover)-
    _sbe.reset_cache()
    abs_entries = _sbe.absence_restriction_entries()
    abs_ids = {e["id"] for e in abs_entries}
    implemented = _sbe.implemented_ids()
    known_open = _sbe.known_open_ids()

    # 5a. the class total matches the histogram, and the partition is a clean
    #     cover of exactly the 699 UBL absence-restriction ids (nothing dropped).
    hist_total = (live_acct["ubl"]["shape_histogram"]
                  .get("absence-restriction", 0))
    check(len(abs_entries) == hist_total,
          "absence-restriction class size %d != histogram %d"
          % (len(abs_entries), hist_total))
    check(set(implemented).isdisjoint(known_open),
          "an id is both implemented and known-open")
    check(set(implemented) | set(known_open) == abs_ids,
          "implemented + known-open is not exactly the UBL absence-restriction "
          "class (an assert was silently dropped)")
    check(len(implemented) + len(known_open) == len(abs_entries),
          "implemented (%d) + known-open (%d) != class total (%d)"
          % (len(implemented), len(known_open), len(abs_entries)))

    # 5b. implemented count: recomputed live, with a floor so a silent collapse
    #     of the evaluator (e.g. a grammar bug) fails the gate.
    live_impl = [e["id"] for e in abs_entries
                 if e.get("context") == _sbe.SUPPORTED_CONTEXT
                 and _sbe.compile_test(e.get("test")) is not None]
    check(sorted(live_impl) == sorted(implemented),
          "implemented_ids() disagrees with a live re-partition of the catalog")
    check(len(implemented) >= 690,
          "implemented count collapsed to %d (< 690 floor) — evaluator "
          "regression?" % len(implemented))

    # 5c. every implemented id is differential-covered: it is exactly the sb
    #     leg's graded id set (differential.py LEG 5), which the differential
    #     gate proves at 0 divergences against the official Schematron.
    check(set(implemented) == set(_diff.SB_RULE_IDS),
          "implemented ids != differential sb-leg graded set "
          "(differential.SB_RULE_IDS) — a differential-uncovered id leaked in")
    check(set(implemented).issubset(abs_ids),
          "an implemented id is not a UBL absence-restriction assert")

    # 5d. the known-open remainder equals EXACTLY the machine-listed worklist in
    #     COVERAGE.md (regression reopens the worklist automatically).
    cov_known_open = _coverage_known_open_ids()
    check(cov_known_open is not None, "COVERAGE.md missing")
    if cov_known_open is not None:
        check(cov_known_open == set(known_open),
              "COVERAGE.md known-open worklist %s != live known-open %s"
              % (sorted(cov_known_open), sorted(known_open)))

    # 5e. severity mirrors the official @flag for every implemented id.
    flag_by_id = {e["id"]: e["flag"] for e in abs_entries}
    for entry in _sbe.implemented_entries():
        want = "fatal" if flag_by_id[entry.id] == "fatal" else "warning"
        check(_sbe._severity_from_flag(entry.flag) == want,
              "implemented id %s severity does not mirror @flag %r"
              % (entry.id, entry.flag))

    # ---- 6. FIRING on the committed targeted fixtures (saxon-free) ----------
    check(os.path.isdir(SB_FIXTURE_DIR),
          "targeted syntax-binding fixture dir missing: %s" % SB_FIXTURE_DIR)
    if os.path.isdir(SB_FIXTURE_DIR):
        impl_set = set(implemented)
        viol_seen = set()
        for name in sorted(os.listdir(SB_FIXTURE_DIR)):
            if not name.endswith("_ubl.xml"):
                continue
            path = os.path.join(SB_FIXTURE_DIR, name)
            findings = _sbe.evaluate(parse_file(path))
            fired = {f["id"] for f in findings}
            # every finding is well-formed + carries the distinct category.
            for f in findings:
                check(f["category"] == "syntax-binding",
                      "%s: finding %s not under 'syntax-binding' category"
                      % (name, f.get("id")))
                check(f["severity"] in ("warning", "fatal"),
                      "%s: finding %s bad severity %r"
                      % (name, f.get("id"), f.get("severity")))
                check(bool(f.get("element")) and bool(f.get("message")),
                      "%s: finding %s missing element/message" % (name, f.get("id")))
            m = re.match(r"^sb-viol-(UBL-(?:CR|DT|SR)-\d+)_ubl\.xml$", name)
            if m:
                rid = m.group(1)
                viol_seen.add(rid)
                check(rid in impl_set,
                      "fixture %s targets non-implemented id %s" % (name, rid))
                check(rid in fired,
                      "violating fixture %s did NOT fire its id %s (fired=%s)"
                      % (name, rid, sorted(fired)))
            elif name.startswith("sb-pass-"):
                # A passing fixture must NOT fire the id it is the clean twin of;
                # sb-pass-clean must fire nothing at all.
                m2 = re.match(r"^sb-pass-(UBL-(?:CR|DT|SR)-\d+)_ubl\.xml$", name)
                if m2:
                    check(m2.group(1) not in fired,
                          "passing fixture %s wrongly fired %s"
                          % (name, m2.group(1)))
                elif name == "sb-pass-clean_ubl.xml":
                    check(not fired,
                          "clean fixture fired syntax-binding ids: %s"
                          % sorted(fired))
        check(len(viol_seen) >= 5,
              "expected >=5 distinct violating fixtures, saw %d" % len(viol_seen))

    # ---- report -----------------------------------------------------------
    if failures:
        sys.stderr.write("SYNTAX-BINDING TEST: FAIL (%d)\n" % len(failures))
        for m in failures:
            sys.stderr.write("  !! " + m + "\n")
        return 1
    print("syntax-binding catalog OK: UBL %d + CII %d = %d non-BR asserts, "
          "catalog == fresh extraction id-for-id, accounting live-consistent."
          % (EXPECTED_TOTALS["ubl"], EXPECTED_TOTALS["cii"],
             EXPECTED_TOTALS["ubl"] + EXPECTED_TOTALS["cii"]))
    print("  UBL absence-restriction: %d implemented (== differential sb-leg "
          "graded set) + %d known-open (== COVERAGE.md worklist) of %d; "
          "targeted fixtures fire/clear as expected."
          % (len(_sbe.implemented_ids()), len(_sbe.known_open_ids()),
             len(_sbe.absence_restriction_entries())))
    return 0


if __name__ == "__main__":
    sys.exit(main())

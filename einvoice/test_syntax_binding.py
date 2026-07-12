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
import gen_sb_fixtures as _genfx  # noqa: E402  (in-memory fixture synthesis)

CATALOG_PATH = os.path.join(HERE, "syntax_binding_catalog.json")
COVERAGE_PATH = os.path.join(HERE, "COVERAGE.md")
SB_FIXTURE_DIR = os.path.join(HERE, "corpus", "vendored", "syntax-binding")
SB_CII_FIXTURE_DIR = os.path.join(HERE, "fixtures")
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


def _coverage_known_open_ids(section, binding="UBL"):
    """The set of ids machine-listed in the 'Known-open worklist' table of ONE
    COVERAGE.md syntax-binding subsection (``binding`` = 'UBL' / 'CII';
    ``section`` = 'absence-restriction' / 'cardinality-count' / 'existence' /
    'datatype-regex' / 'other-complex') — parsed straight from the rendered doc,
    so the test proves code and doc name the SAME remainder."""
    if not os.path.exists(COVERAGE_PATH):
        return None
    text = open(COVERAGE_PATH, encoding="utf-8").read()
    anchor = text.find("### %s %s — implemented vs known-open" % (binding, section))
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
        elif s.startswith("### "):
            break  # next section — stop (even if this section's worklist is empty)
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
    ubl_by_id = {e["id"]: e for e in entries if e.get("binding") == "ubl"}
    abs_entries = _sbe.absence_restriction_entries()
    abs_ids = {e["id"] for e in abs_entries}
    abs_impl = _sbe.absence_implemented_ids()
    abs_ko = _sbe.known_open_ids()
    implemented = _sbe.implemented_ids()          # ALL classes (== SB leg set)

    # 5a. the absence class total matches the histogram, and the partition is a
    #     clean cover of exactly the 699 UBL absence-restriction ids (nothing
    #     dropped).
    hist_total = (live_acct["ubl"]["shape_histogram"]
                  .get("absence-restriction", 0))
    check(len(abs_entries) == hist_total,
          "absence-restriction class size %d != histogram %d"
          % (len(abs_entries), hist_total))
    check(set(abs_impl).isdisjoint(abs_ko),
          "an absence id is both implemented and known-open")
    check(set(abs_impl) | set(abs_ko) == abs_ids,
          "absence implemented + known-open is not exactly the UBL "
          "absence-restriction class (an assert was silently dropped)")
    check(len(abs_impl) + len(abs_ko) == len(abs_entries),
          "absence implemented (%d) + known-open (%d) != class total (%d)"
          % (len(abs_impl), len(abs_ko), len(abs_entries)))

    # 5b. absence implemented count: recomputed live, with a floor so a silent
    #     collapse of the evaluator (e.g. a grammar bug) fails the gate.
    live_abs_impl = [e["id"] for e in abs_entries
                     if e.get("context") == _sbe.SUPPORTED_CONTEXT
                     and _sbe.compile_test(e.get("test")) is not None]
    check(sorted(live_abs_impl) == sorted(abs_impl),
          "absence_implemented_ids() disagrees with a live re-partition")
    check(len(abs_impl) >= 690,
          "absence implemented count collapsed to %d (< 690 floor) — evaluator "
          "regression?" % len(abs_impl))

    # 5c. every implemented id (ALL classes) is differential-covered: it is
    #     exactly the sb leg's graded id set (differential.py LEG 5), which the
    #     differential gate proves at 0 divergences against the official
    #     Schematron. The class partitions are disjoint and cover the union.
    check(set(implemented) == set(_diff.SB_RULE_IDS),
          "implemented ids != differential sb-leg graded set "
          "(differential.SB_RULE_IDS) — a differential-uncovered id leaked in")
    check(set(abs_impl).issubset(abs_ids),
          "an absence implemented id is not a UBL absence-restriction assert")

    # 5d. the absence known-open remainder equals EXACTLY the machine-listed
    #     worklist in COVERAGE.md (regression reopens the worklist automatically).
    cov_known_open = _coverage_known_open_ids("absence-restriction")
    check(cov_known_open is not None, "COVERAGE.md missing")
    if cov_known_open is not None:
        check(cov_known_open == set(abs_ko),
              "COVERAGE.md absence known-open worklist %s != live %s"
              % (sorted(cov_known_open), sorted(abs_ko)))

    # 5e. severity mirrors the official @flag for every implemented id (all
    #     classes).
    for entry in _sbe.implemented_entries():
        want = "fatal" if ubl_by_id[entry.id]["flag"] == "fatal" else "warning"
        check(_sbe._severity_from_flag(entry.flag) == want,
              "implemented id %s severity does not mirror @flag %r"
              % (entry.id, entry.flag))

    # 5f. NEW shape classes (cardinality-count / existence / datatype-regex):
    #     each partitions LIVE into implemented + known-open == class total; the
    #     partitions are disjoint; every implemented id is in the differential
    #     graded set; and the known-open remainder equals the machine-listed
    #     COVERAGE.md worklist for that class — mirroring 5a/5c/5d exactly.
    union_impl = set(abs_impl)
    for shape in _sbe.NEW_CLASSES:
        cls_entries = _sbe.class_entries(shape)
        cls_ids = {e["id"] for e in cls_entries}
        cls_impl = _sbe.class_implemented_ids(shape)
        cls_ko = _sbe.class_known_open_ids(shape)
        cls_hist = live_acct["ubl"]["shape_histogram"].get(shape, 0)
        check(len(cls_entries) == cls_hist,
              "%s class size %d != histogram %d"
              % (shape, len(cls_entries), cls_hist))
        check(set(cls_impl).isdisjoint(cls_ko),
              "%s: an id is both implemented and known-open" % shape)
        check(set(cls_impl) | set(cls_ko) == cls_ids,
              "%s: implemented + known-open is not exactly the class "
              "(an assert was silently dropped)" % shape)
        check(len(cls_impl) + len(cls_ko) == len(cls_entries),
              "%s: implemented (%d) + known-open (%d) != class total (%d)"
              % (shape, len(cls_impl), len(cls_ko), len(cls_entries)))
        check(set(cls_impl).issubset(set(_diff.SB_RULE_IDS)),
              "%s: an implemented id is not in the differential graded set" % shape)
        cov_cls_ko = _coverage_known_open_ids(shape)
        check(cov_cls_ko == set(cls_ko),
              "COVERAGE.md %s known-open worklist %s != live %s"
              % (shape, sorted(cov_cls_ko or []), sorted(cls_ko)))
        union_impl |= set(cls_impl)

    # 5g. the four class partitions exactly reconstruct the global implemented
    #     set — no id lives in two classes and none is dropped between them.
    check(union_impl == set(implemented),
          "per-class implemented union != implemented_ids() (a class leaked or "
          "dropped an id)")

    # 5h. datatype-regex is deliberately left fully known-open (honesty line —
    #     the single UBL-DT lexical restriction is not approximated).
    check(_sbe.class_implemented_ids("datatype-regex") == [],
          "datatype-regex must stay known-open (no hand-faked regex engine)")

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

        # ---- 7. every NEW-class implemented id either has a committed firing
        #         fixture OR is an explicitly-documented firing-unobservable id;
        #         nothing is silently missing a firing proof.
        new_impl = (set(_sbe.class_implemented_ids("cardinality-count"))
                    | set(_sbe.class_implemented_ids("existence")))
        committed_new = viol_seen & new_impl
        missing_fixture = new_impl - committed_new
        unobs = set(_sbe.FIRING_UNOBSERVABLE)
        check(unobs.issubset(new_impl),
              "FIRING_UNOBSERVABLE %s is not a subset of the implemented new "
              "classes" % sorted(unobs))
        check(missing_fixture == unobs,
              "new-class implemented ids without a firing fixture %s != the "
              "documented firing-unobservable set %s"
              % (sorted(missing_fixture), sorted(unobs)))
        # 7b. the firing-unobservable ids are DOCUMENTED in COVERAGE.md (so the
        #     honesty note cannot silently disappear).
        cov_text = open(COVERAGE_PATH, encoding="utf-8").read()
        for rid in sorted(unobs):
            check(("`%s`" % rid) in cov_text,
                  "firing-unobservable id %s is not documented in COVERAGE.md"
                  % rid)
        # 7c. NOT faked: our evaluator DOES fire each firing-unobservable id on an
        #     in-memory synthesized violating instance (only the official XSLT —
        #     which crashes on the plural leaf — cannot grade it).
        entry_by_id = {e.id: e for e in _sbe.implemented_entries()}
        for rid in sorted(unobs):
            entry = entry_by_id.get(rid)
            check(entry is not None, "unobservable id %s not an implemented entry"
                  % rid)
            if entry is not None:
                root = _genfx._mutate(entry).getroot()
                check(rid in _sbe.fired_ids(root),
                      "firing-unobservable id %s does NOT fire on its in-memory "
                      "violating instance (evaluator broken)" % rid)

    # ---- 8. CII IMPLEMENTATION accounting (T-VHSBL.4) — mirror the UBL
    #         implemented-vs-known-open recompute so a catalog/artifact bump
    #         reopens the CII worklist automatically. Does NOT weaken any UBL
    #         assertion above.
    cii_by_id = {e["id"]: e for e in entries if e.get("binding") == "cii"}
    cii_impl_all = _sbe.cii_implemented_ids()

    # 8a. per CII shape class: a clean cover of exactly the class, disjoint,
    #     differential-covered, and the known-open remainder == COVERAGE.md.
    cii_union_impl = set()
    for shape in _sbe.CII_SHAPE_CLASSES:
        cls_entries = _sbe.cii_class_entries(shape)
        cls_ids = {e["id"] for e in cls_entries}
        cls_impl = _sbe.cii_class_implemented_ids(shape)
        cls_ko = _sbe.cii_class_known_open_ids(shape)
        cls_hist = live_acct["cii"]["shape_histogram"].get(shape, 0)
        check(len(cls_entries) == cls_hist,
              "CII %s class size %d != histogram %d"
              % (shape, len(cls_entries), cls_hist))
        check(set(cls_impl).isdisjoint(cls_ko),
              "CII %s: an id is both implemented and known-open" % shape)
        check(set(cls_impl) | set(cls_ko) == cls_ids,
              "CII %s: implemented + known-open is not exactly the class "
              "(an assert was silently dropped)" % shape)
        check(len(cls_impl) + len(cls_ko) == len(cls_entries),
              "CII %s: implemented (%d) + known-open (%d) != class total (%d)"
              % (shape, len(cls_impl), len(cls_ko), len(cls_entries)))
        check(set(cls_impl).issubset(set(_diff.SB_CII_RULE_IDS)),
              "CII %s: an implemented id is not in the differential graded set"
              % shape)
        cov_cls_ko = _coverage_known_open_ids(shape, "CII")
        check(cov_cls_ko == set(cls_ko),
              "COVERAGE.md CII %s known-open worklist %s != live %s"
              % (shape, sorted(cov_cls_ko or []), sorted(cls_ko)))
        cii_union_impl |= set(cls_impl)

    # 8b. the class partitions exactly reconstruct the global CII implemented set,
    #     which is EXACTLY the differential CII sb-leg graded set (LEG 6).
    check(cii_union_impl == set(cii_impl_all),
          "per-class CII implemented union != cii_implemented_ids()")
    check(set(cii_impl_all) == set(_diff.SB_CII_RULE_IDS),
          "cii_implemented_ids() != differential CII sb-leg graded set "
          "(differential.SB_CII_RULE_IDS)")
    check(set(cii_impl_all).isdisjoint(_diff.OUR_RULE_SET),
          "a CII syntax-binding id collides with a BR-* core rule id")

    # 8c. other-complex + datatype-regex stay fully known-open (honesty line — a
    #     compound or regex restriction is never approximated).
    check(_sbe.cii_class_implemented_ids("other-complex") == [],
          "CII other-complex must stay known-open (no faked compound engine)")
    check(_sbe.cii_class_implemented_ids("datatype-regex") == [],
          "CII datatype-regex must stay known-open (no faked regex engine)")

    # 8d. claim-shadowed ids are DEAD-by-Schematron: their @test DOES compile (so
    #     they are excluded for rule-claiming, not for an unsupported form), and
    #     they are all machine-listed known-open in the absence class.
    shadowed = _sbe.cii_claim_shadowed_ids()
    cii_abs_ko = set(_sbe.cii_class_known_open_ids("absence-restriction"))
    for rid in shadowed:
        e = cii_by_id.get(rid)
        check(e is not None, "shadowed id %s not a CII catalog entry" % rid)
        if e is not None:
            check(_sbe.compile_class_test(e["shape"], e["test"],
                                          _sbe.CII_NSMAP) is not None,
                  "claim-shadowed id %s does NOT compile — it should be excluded "
                  "by claiming, not by an unsupported form" % rid)
        check(rid in cii_abs_ko,
              "claim-shadowed id %s not machine-listed known-open" % rid)

    # 8e. severity mirrors the official @flag for every implemented CII id.
    for entry in _sbe.cii_implemented_entries():
        want = "fatal" if cii_by_id[entry.id]["flag"] == "fatal" else "warning"
        check(_sbe._severity_from_flag(entry.flag) == want,
              "CII implemented id %s severity does not mirror @flag %r"
              % (entry.id, entry.flag))

    # 8f. the documented firing-unobservable CII ids are a subset of the
    #     implemented cardinality-count class and are named in COVERAGE.md (so the
    #     honesty note cannot silently disappear).
    cii_unobs = set(_sbe.CII_FIRING_UNOBSERVABLE)
    check(cii_unobs.issubset(set(_sbe.cii_class_implemented_ids(
              "cardinality-count"))),
          "CII_FIRING_UNOBSERVABLE %s is not a subset of the implemented "
          "cardinality-count class" % sorted(cii_unobs))
    cov_text = open(COVERAGE_PATH, encoding="utf-8").read()
    for rid in sorted(cii_unobs):
        check(("`%s`" % rid) in cov_text,
              "firing-unobservable CII id %s is not documented in COVERAGE.md"
              % rid)

    # 8g. FIRING (saxon-free): the clean CII base fires nothing, and EVERY
    #     implemented CII id fires on its committed violation fixture with a
    #     well-formed, category-tagged, @flag-mirroring finding.
    check(os.path.isdir(SB_CII_FIXTURE_DIR),
          "targeted CII syntax-binding fixture dir missing: %s"
          % SB_CII_FIXTURE_DIR)
    if os.path.isdir(SB_CII_FIXTURE_DIR):
        clean = os.path.join(SB_CII_FIXTURE_DIR, "sb-pass-clean_cii.xml")
        check(os.path.exists(clean), "sb-pass-clean_cii.xml base missing")
        if os.path.exists(clean):
            check(not _sbe.cii_fired_ids(parse_file(clean)),
                  "clean CII base fired syntax-binding ids: %s"
                  % sorted(_sbe.cii_fired_ids(parse_file(clean))))
        impl_set = set(cii_impl_all)
        viol_seen = set()
        for name in sorted(os.listdir(SB_CII_FIXTURE_DIR)):
            m = re.match(r"^sb-viol-(CII-(?:DT|SR)-\d+)_cii\.xml$", name)
            if not m:
                continue
            rid = m.group(1)
            path = os.path.join(SB_CII_FIXTURE_DIR, name)
            findings = _sbe.evaluate_cii(parse_file(path))
            fired = {f["id"] for f in findings}
            for f in findings:
                check(f["category"] == "syntax-binding",
                      "%s: finding %s not under 'syntax-binding' category"
                      % (name, f.get("id")))
                check(f["severity"] in ("warning", "fatal"),
                      "%s: finding %s bad severity %r"
                      % (name, f.get("id"), f.get("severity")))
                check(bool(f.get("element")) and bool(f.get("message")),
                      "%s: finding %s missing element/message"
                      % (name, f.get("id")))
            viol_seen.add(rid)
            check(rid in impl_set,
                  "CII fixture %s targets non-implemented id %s" % (name, rid))
            check(rid in fired,
                  "violating CII fixture %s did NOT fire its id %s (fired=%s)"
                  % (name, rid, sorted(fired)[:20]))
        # EVERY implemented CII id has a committed firing fixture (nothing is
        # silently missing a firing proof — CII ships fixtures for all of them,
        # incl. the firing-unobservable-on-official caps).
        check(viol_seen == impl_set,
              "CII implemented ids without a committed firing fixture: %s "
              "(extra fixtures: %s)"
              % (sorted(impl_set - viol_seen)[:20],
                 sorted(viol_seen - impl_set)[:20]))

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
    print("  UBL syntax-binding implemented: %d total (== differential sb-leg "
          "graded set) = %d absence-restriction + %d cardinality-count + %d "
          "existence + %d datatype-regex."
          % (len(_sbe.implemented_ids()), len(_sbe.absence_implemented_ids()),
             len(_sbe.class_implemented_ids("cardinality-count")),
             len(_sbe.class_implemented_ids("existence")),
             len(_sbe.class_implemented_ids("datatype-regex"))))
    print("  Per-class known-open (== COVERAGE.md worklists): absence %d, "
          "cardinality-count %d, existence %d, datatype-regex %d; targeted "
          "fixtures fire/clear as expected."
          % (len(_sbe.known_open_ids()),
             len(_sbe.class_known_open_ids("cardinality-count")),
             len(_sbe.class_known_open_ids("existence")),
             len(_sbe.class_known_open_ids("datatype-regex"))))
    print("  CII syntax-binding implemented: %d total (== differential CII "
          "sb-leg graded set) = %d absence-restriction + %d cardinality-count + "
          "%d existence; %d known-open (incl. 3 claim-shadowed); %d fixtures "
          "fire their id."
          % (len(_sbe.cii_implemented_ids()),
             len(_sbe.cii_class_implemented_ids("absence-restriction")),
             len(_sbe.cii_class_implemented_ids("cardinality-count")),
             len(_sbe.cii_class_implemented_ids("existence")),
             len(_sbe.cii_known_open_ids()), len(_sbe.cii_implemented_ids())))
    return 0


if __name__ == "__main__":
    sys.exit(main())

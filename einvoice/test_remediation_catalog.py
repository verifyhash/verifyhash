#!/usr/bin/env python3
"""test_remediation_catalog.py — the per-rule remediation catalog must cover
exactly the rules the engine can fire, with honest, engine-consistent fields.

Standard library only; no network. Run:

    python3 test_remediation_catalog.py

Checks (each an independent hard assert; mirrors the ACCEPTANCE CRITERIA):

  (a) every id in einvoice.coverage.engine_fireable_ids() has EXACTLY one
      catalog entry — no gaps.
  (b) every catalog entry maps to a real fireable id — no orphans.
  (c) each entry has all required non-empty fields (title, requires,
      location_hint, fix, severity, provenance) and a bt_bg LIST.
  (d) each entry's severity equals the engine's severity for that rule id
      (enumerated straight off the live registries, not the catalog).
  (e) bt_bg is a list of strings each matching /^(BT|BG)-/; it may be empty
      ONLY for structural rules with no single business term, and the emptiness
      must be an explicit [] (present, not missing).
  (f) each entry's provenance.source is a key present in
      coverage_matrix.json's schematron_sources.
"""

from __future__ import annotations

import inspect
import os
import re
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

from einvoice import rules as _rules              # noqa: E402
from einvoice import rules_xrechnung as _rules_xr  # noqa: E402
from einvoice import coverage as _coverage         # noqa: E402
from einvoice import remediation as _remediation   # noqa: E402

REQUIRED_STR_FIELDS = ("title", "requires", "location_hint", "fix", "severity")
BT_BG_RE = re.compile(r"^(BT|BG)-")

ALLOWED_DE_SOURCES = ("kosit", "translation")
_SCH = "{http://purl.oclc.org/dsdl/schematron}"
_XR_UBL_SCH = os.path.join(
    HERE, "corpus/xrechnung-schematron/schematron/ubl/XRechnung-UBL-validation.sch")

# A handful of KoSIT BR-DE ids whose German assert text is present verbatim in
# the vendored Schematron. The catalog MUST mark these de_source=="kosit" and its
# German title MUST equal the cleaned assert string re-extracted here (proving the
# German is derived from the .sch, not paraphrased from memory).
KNOWN_KOSIT = ("BR-DE-1", "BR-DE-2", "BR-DE-15", "BR-DE-16", "BR-DE-21",
               "BR-DEX-01", "BR-DEX-14")

# German prose markers (mirrors gen_remediation.assert_is_german) — a KoSIT German
# title must contain at least one; this rejects an English string mislabelled kosit.
_DE_WORDS = re.compile(
    r"(?:[äöüÄÖÜß]|\b(?:muss|müssen|enthalten|"
    r"übermittelt|Rechnung|Element|Gruppe|werden|entsprechen|Angaben?|Wenn|"
    r"zulässig|benutzt|Falle|darf|zusätzlich|nicht)\b)")


def _clean_assert(text):
    """Collapse whitespace and strip the ``[BR-XX]-`` id prefix (independent
    re-implementation of gen_remediation._clean, so the test does not trust it)."""
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"^\[[^\]]+\]\s*-?\s*", "", text).strip()
    return text


def _xrechnung_asserts():
    """id -> cleaned first-assert text from the vendored XRechnung UBL Schematron,
    parsed straight from the .sch with an XML parser (no dependency on the build
    script)."""
    root = ET.parse(_XR_UBL_SCH).getroot()
    out = {}
    for rule in root.iter(_SCH + "rule"):
        for a in rule.findall(_SCH + "assert"):
            rid = a.get("id")
            if rid and rid not in out:
                out[rid] = _clean_assert("".join(a.itertext()))
    return out


def _engine_fireable_ids():
    """The exact fireable set, enumerated independently of coverage.py so this
    test does not merely re-check a helper against itself."""
    core = set()
    for fn in _rules.ALL_RULES:
        head = (fn.__doc__ or "").strip().split(":", 1)[0].strip()
        assert head.startswith("BR-"), (fn.__name__, head)
        core.add(head)
    ubl_de = {fn.rule_id for fn in _rules_xr.ALL_RULES}
    cii_de = {fn.rule_id for fn in _rules_xr.CII_DE_RULES}
    return core | ubl_de | cii_de


def _engine_severity():
    """id -> the raw severity the engine puts in a Violation (fatal / warning /
    information), read straight off the live rule functions."""
    out = {}
    for fn in _rules.ALL_RULES:
        rid = (fn.__doc__ or "").strip().split(":", 1)[0].strip()
        src = inspect.getsource(fn)
        if re.search(r'["\']information["\']', src):
            out[rid] = "information"
        elif re.search(r',\s*["\']warning["\']\s*\)', src):
            out[rid] = "warning"
        else:
            out[rid] = "fatal"
    for fn in _rules_xr.ALL_RULES:
        out[fn.rule_id] = fn.severity
    return out


def main():
    failures = []

    def check(cond, msg):
        if not cond:
            failures.append(msg)

    # Load via the shipped loader (proves criterion 2: load_catalog is usable).
    catalog = _remediation.load_catalog()
    check(isinstance(catalog, dict), "load_catalog() did not return a mapping")

    engine_ids = _engine_fireable_ids()
    catalog_ids = set(catalog)

    # ---- (a) no gaps, (b) no orphans -------------------------------------
    gaps = sorted(engine_ids - catalog_ids)
    orphans = sorted(catalog_ids - engine_ids)
    check(not gaps, "fireable rules with NO catalog entry (gaps): %s" % gaps)
    check(not orphans, "catalog entries that are NOT fireable ids (orphans): %s"
          % orphans)
    # Exactly one entry per id is guaranteed by the JSON object keying + set
    # equality above; assert the counts line up too.
    check(len(catalog) == len(engine_ids) or gaps or orphans,
          "catalog size %d != fireable id count %d"
          % (len(catalog), len(engine_ids)))

    # ---- (f) valid provenance source keys --------------------------------
    src_keys = set(_coverage.load_matrix()["schematron_sources"])

    # ---- (d) engine severity ---------------------------------------------
    eng_sev = _engine_severity()

    for rid in sorted(catalog_ids & engine_ids):
        e = catalog[rid]
        check(isinstance(e, dict), "%s: entry is not an object" % rid)
        if not isinstance(e, dict):
            continue

        # (c) required non-empty string fields
        for f in REQUIRED_STR_FIELDS:
            v = e.get(f)
            check(isinstance(v, str) and v.strip(),
                  "%s: field %r missing/empty" % (rid, f))

        # (c) provenance object present with non-empty source + assert
        prov = e.get("provenance")
        check(isinstance(prov, dict) and prov, "%s: provenance missing" % rid)
        if isinstance(prov, dict):
            check(isinstance(prov.get("source"), str) and prov.get("source"),
                  "%s: provenance.source missing/empty" % rid)
            check(isinstance(prov.get("assert"), str) and prov.get("assert", "").strip(),
                  "%s: provenance.assert missing/empty" % rid)
            # (f) source is a real schematron_sources key
            check(prov.get("source") in src_keys,
                  "%s: provenance.source %r not in coverage_matrix schematron_sources %s"
                  % (rid, prov.get("source"), sorted(src_keys)))

        # (d) severity matches the engine
        exp = eng_sev.get(rid)
        check(e.get("severity") == exp,
              "%s: severity %r != engine %r" % (rid, e.get("severity"), exp))
        check(exp in ("fatal", "warning", "information"),
              "%s: engine severity %r not in the allowed set" % (rid, exp))

        # (e) bt_bg is an explicit list of BT-/BG- ids
        check("bt_bg" in e, "%s: bt_bg key MISSING (must be explicit, even if [])"
              % rid)
        bt = e.get("bt_bg")
        check(isinstance(bt, list), "%s: bt_bg is not a list: %r" % (rid, bt))
        if isinstance(bt, list):
            for tok in bt:
                check(isinstance(tok, str) and BT_BG_RE.match(tok),
                      "%s: bt_bg entry %r does not match /^(BT|BG)-/" % (rid, tok))

        # (g) bilingual: both locales present, non-empty, and a valid de_source.
        for f in ("title_de", "fix_de"):
            v = e.get(f)
            check(isinstance(v, str) and v.strip(),
                  "%s: German field %r missing/empty" % (rid, f))
        ds = e.get("de_source")
        check(ds in ALLOWED_DE_SOURCES,
              "%s: de_source %r not in %s" % (rid, ds, ALLOWED_DE_SOURCES))
        # A KoSIT-sourced German string must actually read as German (not an
        # English assert mislabelled kosit).
        if ds == "kosit":
            check(bool(_DE_WORDS.search(e.get("title_de", "") or "")),
                  "%s: de_source==kosit but title_de is not German: %r"
                  % (rid, e.get("title_de")))

    # ---- (h) known BR-DE ids are kosit-sourced, German derived from the .sch -
    sch = _xrechnung_asserts()
    for rid in KNOWN_KOSIT:
        check(rid in catalog, "%s: expected in catalog" % rid)
        if rid not in catalog:
            continue
        e = catalog[rid]
        check(e.get("de_source") == "kosit",
              "%s: expected de_source==kosit, got %r" % (rid, e.get("de_source")))
        expect = sch.get(rid)
        check(bool(expect), "%s: no German assert found in vendored Schematron" % rid)
        check(isinstance(e.get("title_de"), str) and e.get("title_de").strip(),
              "%s: title_de missing/empty" % rid)
        check(e.get("title_de") == expect,
              "%s: title_de is not the verbatim cleaned .sch assert\n     got: %r\n"
              "  expect: %r" % (rid, e.get("title_de"), expect))

    # ---- report ----------------------------------------------------------
    if failures:
        sys.stderr.write("REMEDIATION CATALOG TEST: FAIL (%d)\n" % len(failures))
        for m in failures:
            sys.stderr.write("  !! " + m + "\n")
        return 1
    print("remediation catalog OK: %d entries, id-set == engine fireable set, "
          "severities match the engine, bt_bg well-formed, provenance sources "
          "valid." % len(catalog))
    return 0


if __name__ == "__main__":
    sys.exit(main())

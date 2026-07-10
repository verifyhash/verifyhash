#!/usr/bin/env python3
"""test_rules_doc.py — the human-readable rule reference (``einvoice/RULES.md``)
must be a byte-identical render of ``remediation_catalog.json`` and must cover
exactly the rules in the catalog (no orphans, no gaps).

Standard library only; no network. Run:

    python3 test_rules_doc.py

Checks (each an independent hard assert; mirrors the golden/coverage pattern):

  1. RULES.md is byte-for-byte identical to an in-memory re-render of the
     committed catalog via ``gen_rules_doc.render_markdown`` (drift guard: any
     manual edit, or a catalog change without regenerating, fails here).
  2. every rule id in the catalog appears as a ``### <id> — ...`` section in
     RULES.md (no gaps), and every id shown as a section maps to a real catalog
     entry (no orphans) — the section-id set equals the catalog-id set exactly.
  3. BR-DE-15 (the canonical example) is present as a section.
"""

from __future__ import annotations

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

from einvoice import remediation as _remediation  # noqa: E402
import gen_rules_doc as _gen                        # noqa: E402

MD_PATH = os.path.join(HERE, "einvoice", "RULES.md")

# A rule section heading: "### <rule-id> — <title>". The id is the first
# whitespace-free token; anchoring to the "### " + " — " frame means rule ids
# merely MENTIONED in body prose are never mistaken for sections.
SECTION_RE = re.compile(r"^### (\S+) — ", re.MULTILINE)


def _first_diff(a, b):
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            lo = max(0, i - 25)
            return "%d (%r vs %r)" % (i, a[lo:i + 25], b[lo:i + 25])
    return "len %d vs %d" % (len(a), len(b))


def main():
    failures = []

    def check(cond, msg):
        if not cond:
            failures.append(msg)

    check(os.path.exists(MD_PATH), "einvoice/RULES.md is missing")
    if not os.path.exists(MD_PATH):
        sys.stderr.write("RULES DOC TEST: FAIL\n  !! " + failures[0] + "\n")
        return 1

    doc = _remediation.load_catalog_document()
    catalog_ids = set(doc["rules"])
    check(bool(catalog_ids), "catalog has no rules")

    committed = open(MD_PATH, encoding="utf-8").read()

    # ---- 1. byte-identical render ----------------------------------------
    rendered = _gen.render_markdown(doc)
    check(rendered == committed,
          "einvoice/RULES.md is stale: not a byte-identical render of "
          "remediation_catalog.json (re-run gen_rules_doc.py). first diff at "
          "offset %s" % _first_diff(rendered, committed))

    # ---- 2. section-id set == catalog-id set (no gaps, no orphans) --------
    section_ids = SECTION_RE.findall(committed)
    dups = sorted({x for x in section_ids if section_ids.count(x) > 1})
    check(not dups, "duplicate rule sections in RULES.md: %s" % dups)
    section_set = set(section_ids)

    gaps = sorted(catalog_ids - section_set)
    orphans = sorted(section_set - catalog_ids)
    check(not gaps, "catalog rules with NO section in RULES.md (gaps): %s" % gaps)
    check(not orphans,
          "RULES.md sections that are NOT catalog ids (orphans): %s" % orphans)

    # ---- 3. the canonical BR-DE-15 example is present --------------------
    check("BR-DE-15" in section_set,
          "RULES.md has no section for BR-DE-15")

    if failures:
        sys.stderr.write("RULES DOC TEST: FAIL (%d)\n" % len(failures))
        for m in failures:
            sys.stderr.write("  !! " + m + "\n")
        return 1
    print("rules doc OK: RULES.md byte-identical to a fresh render, %d rule "
          "sections == %d catalog ids (no orphans/gaps), BR-DE-15 present."
          % (len(section_set), len(catalog_ids)))
    return 0


if __name__ == "__main__":
    sys.exit(main())

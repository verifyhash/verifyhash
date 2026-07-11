#!/usr/bin/env python3
"""Build the human-readable rule reference (``einvoice/RULES.md``).

RULES.md is a browsable, plain-language index of every rule the einvoice engine
can fire, grouped by rule family. It is rendered ENTIRELY from the committed
``remediation_catalog.json`` (read via
:func:`einvoice.remediation.load_catalog_document`) — there is NO hand-maintained
second copy, exactly like ``gen_remediation.py`` builds the catalog and
``gen_coverage.py`` renders ``COVERAGE.md``.

Nothing here is authored from memory: every per-rule string (title, what the rule
requires, the BT/BG business terms, the XML location hint, the one-line fix, the
severity and the Schematron provenance) is copied verbatim out of the catalog,
whose own fields are derived from the vendored official Schematron (``corpus/``)
plus the EN 16931 BT/BG model. Family headings are standard rule-family labels
used purely for navigation. Edit the catalog (or the rule it derives from), not
this generated file.

Standard library only; no network.

    python3 gen_rules_doc.py            # write einvoice/RULES.md
    python3 gen_rules_doc.py --check    # fail if the committed file is stale
"""

from __future__ import annotations

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

from einvoice import remediation as _remediation  # noqa: E402

# RULES.md lives INSIDE the package directory (next to the package README),
# as required by the task gate: einvoice/einvoice/RULES.md.
OUT_PATH = os.path.join(HERE, "einvoice", "RULES.md")

# Standard EN 16931 / XRechnung rule-family labels — navigation headings only.
# These describe which family a section covers; they assert no per-rule meaning
# (every substantive per-rule string is rendered from the catalog fields).
FAMILY_LABELS = {
    "BR": "Core EN 16931 content and cardinality rules.",
    "BR-CL": "Code-list rules — a coded value must come from the referenced "
             "official code list.",
    "BR-CO": "Calculation and consistency rules (cross-total arithmetic).",
    "BR-DEC": "Decimal-places rules — amounts must not exceed the allowed "
              "number of decimals.",
    "BR-AE": "VAT breakdown rules for VAT category code AE.",
    "BR-AF": "VAT breakdown rules for VAT category code L (IGIC, Canary "
             "Islands general indirect tax).",
    "BR-AG": "VAT breakdown rules for VAT category code M (IPSI, tax for "
             "Ceuta and Melilla).",
    "BR-B": "VAT breakdown rules for VAT category code B (Italian "
            "split payment).",
    "BR-E": "VAT breakdown rules for VAT category code E.",
    "BR-G": "VAT breakdown rules for VAT category code G.",
    "BR-IC": "VAT breakdown rules for the intra-community VAT category.",
    "BR-O": "VAT breakdown rules for VAT category code O.",
    "BR-S": "VAT breakdown rules for VAT category code S.",
    "BR-Z": "VAT breakdown rules for VAT category code Z.",
    "BR-DE": "German XRechnung national CIUS rules (KoSIT).",
    "BR-DE-TMP": "German XRechnung national rules (BR-DE-TMP).",
    "BR-DEX": "German XRechnung extension-layer rules (BR-DEX).",
    "PEPPOL-EN16931": "Peppol-derived rules as vendored inside the official "
                      "KoSIT XRechnung Schematron artifact — the "
                      "KoSIT-vendored subset only, NOT full Peppol BIS "
                      "Billing 3.0 support.",
}


def family_of(rule_id):
    """The rule-family key of a rule id.

    Strips a trailing single-letter variant suffix (``-a`` / ``-b``) and the
    trailing rule number, leaving the family prefix: ``BR-01`` -> ``BR``,
    ``BR-DE-15`` -> ``BR-DE``, ``BR-DE-23-a`` -> ``BR-DE``,
    ``BR-DE-TMP-32`` -> ``BR-DE-TMP``, ``BR-DEX-01`` -> ``BR-DEX``,
    ``PEPPOL-EN16931-R001`` -> ``PEPPOL-EN16931`` (the ``R``-prefixed rule
    number of the Peppol family is stripped like a plain number).
    """
    toks = rule_id.split("-")
    if len(toks) > 2 and toks[-1].isalpha() and len(toks[-1]) == 1:
        toks = toks[:-1]
    if toks[-1].isdigit() or re.fullmatch(r"R\d+", toks[-1]):
        toks = toks[:-1]
    return "-".join(toks)


def _group(rules):
    """Ordered ``[(family, [rule_id, ...]), ...]``.

    Families appear in the order they are first seen in the catalog, which is the
    canonical family/id order ``gen_remediation.py`` writes; rules keep their
    catalog order within each family."""
    order = []
    buckets = {}
    for rid in rules:
        fam = family_of(rid)
        if fam not in buckets:
            buckets[fam] = []
            order.append(fam)
        buckets[fam].append(rid)
    return [(fam, buckets[fam]) for fam in order]


def render_markdown(doc):
    """Render the full ``RULES.md`` text from a parsed catalog document.

    Pure and deterministic: the output depends only on ``doc`` (no clock, no
    environment, stable ordering), so ``test_rules_doc.py`` can regenerate it in
    memory and assert byte-equality with the committed file.
    """
    rules = doc["rules"]
    lines = []
    w = lines.append

    w("# einvoice — Rule Reference")
    w("")
    w("<!-- GENERATED FILE — do not edit by hand.")
    w("     Regenerate with `python3 gen_rules_doc.py` (renders from")
    w("     remediation_catalog.json via")
    w("     einvoice.remediation.load_catalog_document).")
    w("     test_rules_doc.py asserts this file is byte-identical to a fresh")
    w("     render, so any manual edit will fail the gate. -->")
    w("")
    w("This is a browsable, plain-language reference to every EN 16931 / "
      "XRechnung")
    w("business rule the einvoice engine can fire. Each entry is rendered "
      "straight")
    w("from `remediation_catalog.json`, whose fields are **derived** from the")
    w("vendored official Schematron (`corpus/`) and the EN 16931 BT/BG "
      "business-term")
    w("model — they are not authored from memory. To change any wording here, "
      "edit")
    w("the catalog (or the rule it derives from) and re-run `gen_rules_doc.py`; "
      "do")
    w("not edit this file.")
    w("")
    w("Each rule shows these catalog fields:")
    w("")
    w("- **Requires** — what the rule demands (`requires`).")
    w("- **Business terms** — the EN 16931 BT-/BG- ids the rule touches "
      "(`bt_bg`).")
    w("- **Location** — the XML path/element a finding concerns "
      "(`location_hint`).")
    w("- **Fix** — a one-line corrective action (`fix`).")
    w("- **Severity** — engine severity: `fatal` blocks validity; `warning` / "
      "`information`")
    w("  are reported but non-blocking (`severity`).")
    w("- **Provenance** — the Schematron source key plus the verbatim official")
    w("  assert the wording is derived from (`provenance`).")
    w("")
    w("Family headings are standard EN 16931 / XRechnung rule-family labels used")
    w("only for navigation; every substantive per-rule string above comes from "
      "the")
    w("catalog.")
    w("")

    groups = _group(rules)
    n = len(rules)
    fatal = sum(1 for e in rules.values() if e.get("severity") == "fatal")
    warn = sum(1 for e in rules.values() if e.get("severity") == "warning")
    info = sum(1 for e in rules.values() if e.get("severity") == "information")
    w("**%d rules** in total — %d fatal, %d warning, %d information — across "
      "%d families."
      % (n, fatal, warn, info, len(groups)))
    w("")

    # Family index.
    w("## Families")
    w("")
    for fam, ids in groups:
        label = FAMILY_LABELS.get(fam, "%s rules." % fam)
        w("- **%s** (%d) — %s" % (fam, len(ids), label))
    w("")

    # One section per family, one subsection per rule.
    for fam, ids in groups:
        label = FAMILY_LABELS.get(fam, "%s rules." % fam)
        w("## %s" % fam)
        w("")
        w(label)
        w("")
        for rid in ids:
            e = rules[rid]
            w("### %s — %s" % (rid, e["title"]))
            w("")
            w("- **Requires:** %s" % e["requires"])
            bt = e.get("bt_bg") or []
            w("- **Business terms:** %s"
              % (", ".join(bt) if bt else "— (no single business term)"))
            w("- **Location:** `%s`" % e["location_hint"])
            w("- **Fix:** %s" % e["fix"])
            w("- **Severity:** %s" % e["severity"])
            prov = e.get("provenance") or {}
            w("- **Provenance:** `%s` — “%s”"
              % (prov.get("source", ""), (prov.get("assert", "") or "").strip()))
            w("")

    return "\n".join(lines) + "\n"


def main(argv):
    doc = _remediation.load_catalog_document()
    text = render_markdown(doc)
    if "--check" in argv:
        cur = open(OUT_PATH, encoding="utf-8").read() if os.path.exists(OUT_PATH) else None
        if cur != text:
            sys.stderr.write("stale (re-run gen_rules_doc.py): %s\n"
                             % os.path.basename(OUT_PATH))
            return 1
        print("RULES.md up to date (%d rules)" % len(doc["rules"]))
        return 0
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        fh.write(text)
    print("wrote %s (%d rules)" % (OUT_PATH, len(doc["rules"])))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

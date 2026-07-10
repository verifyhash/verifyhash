#!/usr/bin/env python3
"""Build the per-rule remediation catalog (``remediation_catalog.json``).

This is the SINGLE machine-readable source of truth for human-facing rule
remediation guidance — the report writer, RULES.md and a future ``--explain``
flag all read it via :func:`einvoice.remediation.load_catalog`.

Every string is DERIVED, never invented:

* ``id`` / ``severity`` / ``provenance.source`` come from the live engine
  (:mod:`einvoice.rules` + :mod:`einvoice.rules_xrechnung`) and the published
  ``coverage_matrix.json`` — the same ground truth ``gen_coverage.py`` uses.
* ``title`` is the engine-derived short name already carried in the coverage
  matrix (first line of each rule's docstring).
* ``provenance.assert`` is the verbatim assert sentence lifted straight out of
  the vendored official Schematron (``corpus/``) with an XML parser — the exact
  wording every other field paraphrases faithfully.
* ``requires`` restates that assert (English core/BR-CL asserts verbatim; the
  German KoSIT BR-DE/BR-DEX asserts via the engine's own committed English
  docstring, which is a faithful transcription of the same rule).
* ``bt_bg`` is the set of EN 16931 BT-/BG- business-term ids literally named in
  the assert text / title — parsed out, never guessed.
* ``location_hint`` is the Schematron ``rule/@context`` the assert binds to
  (for document-root contexts, refined with the target element read out of the
  assert's ``@test`` XPath).
* ``fix`` is a mechanical imperative composed from an action verb (chosen by
  rule family / test shape) + the location + the verbatim requirement.

Standard library only; no network.

    python3 gen_remediation.py            # write remediation_catalog.json
    python3 gen_remediation.py --check    # fail if the committed file is stale
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

from einvoice import rules as _rules              # noqa: E402
from einvoice import rules_xrechnung as _rules_xr  # noqa: E402
from einvoice import coverage as _coverage         # noqa: E402

OUT_PATH = os.path.join(HERE, "remediation_catalog.json")
SCH = "{http://purl.oclc.org/dsdl/schematron}"

# The official UBL Schematron artifacts every fireable rule can be read out of.
# (Every engine-fireable id fires on the UBL leg — the CII layer is a subset —
# so the UBL sources are the canonical provenance.)
CORE_VALIDATION = os.path.join(
    HERE, "corpus/cen-en16931/ubl/schematron/preprocessed/"
    "EN16931-UBL-validation-preprocessed.sch")
CORE_CODES = os.path.join(
    HERE, "corpus/cen-en16931/ubl/schematron/codelist/EN16931-UBL-codes.sch")
XR_VALIDATION = os.path.join(
    HERE, "corpus/xrechnung-schematron/schematron/ubl/XRechnung-UBL-validation.sch")


# --------------------------------------------------------------------------- #
# Schematron extraction.                                                       #
# --------------------------------------------------------------------------- #
def _clean(text):
    """Collapse whitespace and strip the ``[BR-XX]-`` id tag Schematron prefixes
    every assert message with."""
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"^\[[^\]]+\]\s*-?\s*", "", text).strip()
    return text


def _parse_sch(path):
    """id -> {context, test, flag, assert_text} for the FIRST assert of each id
    in a Schematron file (XML-parsed, so ``>`` inside @test is handled)."""
    root = ET.parse(path).getroot()
    out = {}
    for rule in root.iter(SCH + "rule"):
        ctx = rule.get("context")
        if ctx is None:
            continue
        for a in rule.findall(SCH + "assert"):
            rid = a.get("id")
            if not rid or rid in out:
                continue
            out[rid] = {
                "context": ctx.strip(),
                "test": a.get("test"),
                "flag": a.get("flag"),
                "assert_text": _clean("".join(a.itertext())),
            }
    return out


def load_schematron_index():
    """Merge the three UBL Schematron artifacts into one id -> assert record.
    Validation asserts win over the code-list file where both define an id."""
    idx = {}
    idx.update(_parse_sch(CORE_CODES))
    idx.update(_parse_sch(CORE_VALIDATION))
    idx.update(_parse_sch(XR_VALIDATION))
    return idx


# --------------------------------------------------------------------------- #
# Engine facts (severity + source key), mirrored from gen_coverage.py.         #
# --------------------------------------------------------------------------- #
def _core_fns():
    return {_coverage._core_rule_id(fn): fn for fn in _rules.ALL_RULES}


def _xr_fns():
    return {fn.rule_id: fn for fn in _rules_xr.ALL_RULES}


def _core_severity(fn):
    """Raw Schematron flag the core rule emits (fatal unless it passes a
    'warning'/'information' literal to Violation) — same read as gen_coverage."""
    import inspect
    src = inspect.getsource(fn)
    if re.search(r'["\']information["\']', src):
        return "information"
    if re.search(r',\s*["\']warning["\']\s*\)', src):
        return "warning"
    return "fatal"


def engine_severity(rid, core_fns, xr_fns):
    if rid in xr_fns:
        return xr_fns[rid].severity
    return _core_severity(core_fns[rid])


def source_key(rid):
    """The coverage-matrix schematron_sources key the wording is derived from."""
    if rid.startswith("BR-DE") or rid.startswith("BR-DEX"):
        return "xrechnung-ubl"
    return "en16931-ubl"


# --------------------------------------------------------------------------- #
# Field derivation.                                                            #
# --------------------------------------------------------------------------- #
_BT_BG_RE = re.compile(r"\b(B[TG]-(?:DEX-)?\d+[a-z]?)\b")


def derive_bt_bg(*texts):
    """Sorted, de-duplicated BT-/BG- ids literally named in the given texts."""
    found = set()
    for t in texts:
        if not t:
            continue
        found.update(_BT_BG_RE.findall(t))

    def key(tok):
        pref, rest = tok.split("-", 1)
        dex = rest.startswith("DEX-")
        num = rest[4:] if dex else rest
        m = re.match(r"(\d+)([a-z]?)", num)
        return (0 if pref == "BG" else 1, 1 if dex else 0,
                int(m.group(1)) if m else 0, m.group(2) if m else "")

    return sorted(found, key=key)


_DOC_ROOTS = {"/ubl:Invoice", "/ubl:Invoice/", "/*", "/*/"}

# Clean cac/cbc path at the head of an XPath test (presence checks etc.).
_LEAD_PATH = re.compile(
    r"^\s*(?:exists|normalize-space|count|string-length|not|boolean|number|"
    r"round|sum)?\(*\s*"
    r"((?:cac|cbc):[A-Za-z]+(?:/(?:cac|cbc):[A-Za-z]+)*)")
# A VAT category node keyed by its category letter, anywhere in the test.
_CAT_NODE = re.compile(
    r"(cac:(?:Classified)?TaxCategory)\[normalize-space\(cbc:ID\)\s*=\s*'([A-Z]+)'\]")
# Fallback: first cac/cbc path token anywhere in the test.
_ANY_PATH = re.compile(r"(?://)?((?:cac|cbc):[A-Za-z]+(?:/(?:cac|cbc):[A-Za-z]+)*)")


def canonical_context(ctx):
    """The UBL branch of a Schematron context, with extension predicates and the
    ``/*/`` wildcard normalised to a readable path."""
    part = ctx.split("|")[0].strip()
    part = part.replace("[$isExtension]", "")
    part = part.replace("/*/", "/ubl:Invoice/")
    return part.strip()


def derive_location(rid, rec):
    """The XML path/element the finding concerns.

    Uses the Schematron rule context; when that context is the whole document,
    reads the concrete target element out of the assert's @test XPath so the hint
    points at a real element rather than the document root."""
    canon = canonical_context(rec["context"])
    if canon not in _DOC_ROOTS:
        return canon
    test = rec.get("test") or ""
    # 1) a clean leading element path (presence-style tests)
    m = _LEAD_PATH.match(test)
    if m and not m.group(1).endswith(("exists", "count")):
        return m.group(1)
    # 2) a VAT-category node keyed by its category letter
    m = _CAT_NODE.search(test)
    if m:
        node = m.group(1)
        if node == "cac:TaxCategory":
            return "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory[cbc:ID='%s']" % m.group(2)
        return "cac:InvoiceLine/cac:Item/%s[cbc:ID='%s']" % (node, m.group(2))
    # 3) document-total rules concern the monetary total, not the first path
    #    token their currency-scoped test happens to name
    if rid.startswith("BR-CO"):
        return "cac:LegalMonetaryTotal"
    # 4) any cac/cbc path anywhere in the test
    m = _ANY_PATH.search(test)
    if m:
        return m.group(1)
    return "/ubl:Invoice (document level)"


def _requires(rid, rec, xr_fns, title):
    """What the rule demands, in English.

    Core / BR-CL asserts are already English — use the verbatim assert sentence.
    The KoSIT BR-DE / BR-DEX asserts are German; use the engine's own committed
    English docstring (a faithful transcription of the same rule) instead."""
    if rid in xr_fns:
        doc = (xr_fns[rid].__doc__ or "").strip()
        para = doc.split("\n\n", 1)[0]
        para = re.sub(r"\s+", " ", para).strip()
        if para.startswith(rid + ":"):
            para = para[len(rid) + 1:].strip()
        elif para.startswith(rid):
            para = para[len(rid):].lstrip(":").strip()
        return para or title
    return rec["assert_text"] or title


_CODELIST_RE = re.compile(
    r"((?:ISO|UNCL|UN/ECE|CEF|UNTDID|MIME)[\w /.-]*?(?:code list|Recommendation "
    r"\d+|MIMEMediaType|alpha-3|4217|5305|4461|3166-1|6523|VATEX|EAS)[\w /.-]*)",
    re.IGNORECASE)


def derive_fix(rid, rec, requires, location, xr_fns):
    """A one-line, mechanically-composed imperative: an action verb chosen from
    the rule family / test shape, the target location, and the verbatim
    requirement. No rule meaning is invented — the requirement is the assert."""
    req = requires.rstrip(".")
    test = rec.get("test") or ""
    loc = "`%s`" % location

    if rid.startswith("BR-CL"):
        m = _CODELIST_RE.search(rec.get("assert_text") or requires)
        code = m.group(1).strip() if m else "the required code list"
        return "Encode %s using a valid value from %s." % (loc, code)
    if rid.startswith("BR-DEC"):
        return "Round the value at %s to the allowed number of decimals: %s." % (loc, req)
    if "=" in requires or "Σ" in requires or requires.lower().startswith("sum "):
        return "Correct the calculated amount at %s so that %s." % (loc, req)
    presence = bool(re.search(r"exists\(|!=\s*''|count\([^)]*\)\s*>\s*0", test)) \
        or " shall have " in requires or " shall contain " in requires \
        or "must contain" in requires.lower() or "must be transmitted" in requires.lower()
    if presence and (rid in xr_fns or not re.search(r"'[A-Z]{1,3}'", test)):
        return "Add the required element at %s: %s." % (loc, req)
    if rid.split("-")[1] in ("AE", "E", "G", "S", "Z", "O", "IC"):
        return "Adjust the VAT breakdown at %s so that %s." % (loc, req)
    return "Correct %s so that %s." % (loc, req)


# --------------------------------------------------------------------------- #
# Assembly.                                                                    #
# --------------------------------------------------------------------------- #
def build_catalog():
    matrix = _coverage.load_matrix()
    title_by_id = {r["id"]: r["title"] for r in matrix["rules"]}
    src_keys = set(matrix["schematron_sources"])

    idx = load_schematron_index()
    core_fns = _core_fns()
    xr_fns = _xr_fns()
    ids = sorted(_coverage.engine_fireable_ids(), key=_sort_key)

    catalog = {}
    for rid in ids:
        rec = idx.get(rid)
        if rec is None:
            raise SystemExit("no Schematron assert found for fireable rule %s" % rid)
        title = title_by_id[rid]
        requires = _requires(rid, rec, xr_fns, title)
        location = derive_location(rid, rec)
        skey = source_key(rid)
        if skey not in src_keys:
            raise SystemExit("source key %r not in coverage matrix" % skey)
        entry = {
            "title": title,
            "requires": requires,
            "bt_bg": derive_bt_bg(title, requires, rec["assert_text"]),
            "location_hint": location,
            "fix": derive_fix(rid, rec, requires, location, xr_fns),
            "severity": engine_severity(rid, core_fns, xr_fns),
            "provenance": {
                "source": skey,
                "assert": rec["assert_text"],
            },
        }
        catalog[rid] = entry
    return catalog


def _sort_key(rid):
    toks = rid.split("-")
    suffix = ""
    if toks[-1].isalpha() and len(toks[-1]) == 1:
        suffix = toks[-1]
        toks = toks[:-1]
    num = int(toks[-1]) if toks[-1].isdigit() else -1
    family = "-".join(toks[:-1]) if toks[-1].isdigit() else "-".join(toks)
    order = ["BR", "BR-CL", "BR-CO", "BR-DEC", "BR-AE", "BR-E", "BR-G",
             "BR-IC", "BR-O", "BR-S", "BR-Z", "BR-DE", "BR-DE-TMP", "BR-DEX"]
    rank = order.index(family) if family in order else len(order)
    return (rank, family, num, suffix)


def render(catalog):
    doc = {
        "artifact": "einvoice per-rule remediation catalog",
        "description": (
            "Human-facing remediation guidance for every EN 16931 / XRechnung "
            "rule the einvoice engine can fire. One entry per rule id "
            "(einvoice.coverage.engine_fireable_ids); every field is derived "
            "from the vendored official Schematron assert text (corpus/) and "
            "the EN 16931 BT/BG model, not authored from memory. This is the "
            "single source the report writer, RULES.md and --explain read."),
        "generated_by": "gen_remediation.py",
        "rule_count": len(catalog),
        "rules": catalog,
    }
    return json.dumps(doc, ensure_ascii=False, indent=2) + "\n"


def main(argv):
    text = render(build_catalog())
    if "--check" in argv:
        cur = open(OUT_PATH, encoding="utf-8").read() if os.path.exists(OUT_PATH) else None
        if cur != text:
            sys.stderr.write("stale (re-run gen_remediation.py): %s\n"
                             % os.path.basename(OUT_PATH))
            return 1
        print("remediation catalog up to date")
        return 0
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        fh.write(text)
    n = json.loads(text)["rule_count"]
    print("wrote %s (%d rules)" % (os.path.basename(OUT_PATH), n))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

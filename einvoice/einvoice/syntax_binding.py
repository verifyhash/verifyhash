#!/usr/bin/env python3
"""syntax_binding.py — machine-extract + classify the EN 16931 *syntax-binding*
asserts (the non-``BR-*`` family) out of the vendored preprocessed CEN
Schematron artifacts.

These asserts are NOT EN 16931 business rules. They are the syntax-layer
restrictions the CEN model layers onto a concrete syntax binding:

* ``UBL-CR-*`` / ``CII-*`` *conformance restrictions* — "this UBL/CII element
  MUST NOT appear" (the EN 16931 core model has no slot for it),
* ``*-DT-*`` *data-type restrictions* — attribute-presence / decimal-format /
  length constraints on a leaf value,
* ``*-SR-*`` *syntax rules* — mostly ``count(...)`` cardinality caps ("at most
  one of X").

This module is a MEASUREMENT + DESIGN artifact only. It does **not** evaluate
any assert and does **not** touch the 286-rule business-rule matrix. Its job is
to enumerate the 756 UBL + 583 CII syntax-binding asserts, mechanically
classify each ``@test`` into a coarse *shape* class, and hand back a histogram
that decides the batch order for any later implementation work.

Standard library only (``xml.etree.ElementTree`` + ``json``); zero new deps.
Paths are resolved lazily inside the functions so importing the module never
requires the vendored ``corpus/`` tree (the packaged wheel ships without it).
"""

from __future__ import annotations

import os
import re
import xml.etree.ElementTree as ET

_SCH_NS = "{http://purl.oclc.org/dsdl/schematron}"

# The two vendored preprocessed CEN artifacts, relative to the einvoice project
# root (the directory that holds ``corpus/``).
ARTIFACTS = {
    "ubl": "corpus/cen-en16931/ubl/schematron/preprocessed/"
           "EN16931-UBL-validation-preprocessed.sch",
    "cii": "corpus/cen-en16931/cii/schematron/preprocessed/"
           "EN16931-CII-validation-preprocessed.sch",
}

# Which id prefixes are the syntax-binding (non-BR) family for each binding.
# BR-* asserts are the business-rule matrix and are deliberately excluded.
_ID_RE = {
    "ubl": re.compile(r"^UBL-(?:CR|DT|SR)-\d+$"),
    "cii": re.compile(r"^CII-(?:DT|SR)-\d+$"),
}

# The mechanical shape classes, in report order, with their plain-language
# definition (committed into the catalog so the classification is auditable).
SHAPE_CLASSES = {
    "absence-restriction":
        "the test is a negated presence check — not(...) — asserting a "
        "UBL/CII element or attribute MUST NOT appear (the EN 16931 core "
        "model has no slot for it). Dominates the *-CR-* family.",
    "cardinality-count":
        "the test compares a count(...) of repeated nodes against a bound "
        "(e.g. count(x) <= 1) — a cardinality cap. Dominates the *-SR-* "
        "family.",
    "datatype-regex":
        "the test constrains a leaf value's lexical form — matches(), "
        "string-length(), or a substring/number decimal-place check. The "
        "*-DT-* decimal/format restrictions.",
    "existence":
        "the test asserts a node or attribute simply EXISTS — exists(...), "
        "a bare parenthesized location path, an @attr presence, or a "
        "normalize-space(...) != '' non-empty check.",
    "other-complex":
        "a compound conditional the four coarse shapes above do not capture "
        "(e.g. an and/or co-occurrence constraint) — flagged for hand review.",
}

# Detected substrings for the datatype-regex shape.
_DT_TOKENS = ("matches(", "string-length(", "substring-after(",
              "substring-before(", "number(")


def project_root():
    """Directory that holds ``corpus/`` (the einvoice project root)."""
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def artifact_path(binding, root=None):
    if root is None:
        root = project_root()
    return os.path.join(root, ARTIFACTS[binding])


def _is_single_group(s):
    """True when ``s`` is one balanced parenthesized group (the opening paren
    matches the final char), so ``(a/b/c)`` is one group but ``(a) or (b)`` is
    not."""
    if not (s.startswith("(") and s.endswith(")")):
        return False
    depth = 0
    for i, ch in enumerate(s):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0 and i != len(s) - 1:
                return False
    return depth == 0


def classify(test):
    """Mechanically map a raw ``@test`` XPath to exactly one shape class.

    Purely pattern-based and deterministic — it looks at the SHAPE of the
    expression, never at which id family the assert belongs to (so a ``*-DT-*``
    assert whose test is ``not(@schemeName)`` is honestly an
    ``absence-restriction``, not forced into ``datatype-regex``). Precedence,
    highest first:

    1. ``count(``            -> cardinality-count  (a count comparison wins even
                                                    when negated, e.g.
                                                    ``not(x) or count(x)=1``)
    2. a datatype token      -> datatype-regex
    3. ``not(``              -> absence-restriction
    4. an existence pattern  -> existence
    5. otherwise             -> other-complex
    """
    s = (test or "").strip()
    if "count(" in s:
        return "cardinality-count"
    if any(tok in s for tok in _DT_TOKENS):
        return "datatype-regex"
    if "not(" in s:
        return "absence-restriction"
    if ("exists(" in s or "!= ''" in s or "!=''" in s
            or s.startswith("(@") or s.startswith("@")):
        return "existence"
    if _is_single_group(s):
        inner = s[1:-1]
        if not any(op in inner for op in ("=", "<", ">", " or ", " and ", "not")):
            return "existence"
    return "other-complex"


def id_prefix(assert_id):
    """The id-family prefix, e.g. ``UBL-CR`` from ``UBL-CR-001``."""
    return assert_id.rsplit("-", 1)[0]


def extract(binding, root=None):
    """Extract every syntax-binding (non-BR) assert of one binding.

    A REAL XML parse of the vendored ``.sch`` — walk each ``<rule>`` in
    document order, then each child ``<assert>`` whose ``@id`` matches the
    binding's non-BR prefix, capturing the enclosing rule ``@context``. Returns
    a list of dicts (``id``, ``binding``, ``context``, ``test``, ``flag``,
    ``shape``) in document order.
    """
    path = artifact_path(binding, root)
    id_re = _ID_RE[binding]
    entries = []
    for rule in ET.parse(path).getroot().iter(_SCH_NS + "rule"):
        context = rule.get("context") or ""
        for a in rule.findall(_SCH_NS + "assert"):
            rid = a.get("id") or ""
            if not id_re.match(rid):
                continue
            test = a.get("test") or ""
            entries.append({
                "id": rid,
                "binding": binding,
                "context": context,
                "test": test,
                "flag": a.get("flag") or "fatal",
                "shape": classify(test),
            })
    return entries


def extract_all(root=None):
    """``{"ubl": [...], "cii": [...]}`` — both bindings, document order."""
    return {b: extract(b, root) for b in ("ubl", "cii")}


def _counts(entries):
    """(shape_histogram, prefix_counts) for one binding's entry list."""
    shape = {k: 0 for k in SHAPE_CLASSES}
    prefix = {}
    for e in entries:
        shape[e["shape"]] += 1
        prefix[id_prefix(e["id"])] = prefix.get(id_prefix(e["id"]), 0) + 1
    # Drop shape classes that never occur so the histogram is honest, but keep
    # deterministic order by rebuilding from SHAPE_CLASSES order.
    shape = {k: v for k, v in shape.items() if v}
    return shape, dict(sorted(prefix.items()))


def _pct(part, whole):
    return round(100.0 * part / whole, 1) if whole else 0.0


def accounting(root=None):
    """Per-binding measurement: totals, per-shape histogram (+ %), per-prefix
    counts. Live-computed from the artifacts — nothing is trusted from JSON."""
    data = extract_all(root)
    out = {}
    for binding, entries in data.items():
        shape, prefix = _counts(entries)
        total = len(entries)
        out[binding] = {
            "total": total,
            "shape_histogram": shape,
            "shape_pct": {k: _pct(v, total) for k, v in shape.items()},
            "prefix_counts": prefix,
        }
    return out


def build_catalog(root=None):
    """The full committed catalog document (regenerable table + histogram)."""
    data = extract_all(root)
    acct = accounting(root)
    entries = data["ubl"] + data["cii"]
    return {
        "description":
            "Machine-extracted catalog of the EN 16931 syntax-binding "
            "(non-BR) asserts from the two vendored preprocessed CEN "
            "Schematron artifacts. MEASUREMENT + DESIGN ONLY: no assert here "
            "is evaluated by the engine and none is counted in the 286 "
            "business-rule coverage matrix. Regenerate with "
            "`python3 gen_syntax_binding.py`; test_syntax_binding.py re-parses "
            "the artifacts and fails if this file drifts id-for-id.",
        "generated_by": "gen_syntax_binding.py",
        "artifacts": {b: ARTIFACTS[b] for b in ("ubl", "cii")},
        "id_families": {
            "ubl": ["UBL-CR", "UBL-DT", "UBL-SR"],
            "cii": ["CII-DT", "CII-SR"],
        },
        "shape_classes": SHAPE_CLASSES,
        "accounting": acct,
        "entry_fields": ["id", "binding", "context", "test", "flag", "shape"],
        "entries": entries,
    }

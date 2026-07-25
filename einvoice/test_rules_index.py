#!/usr/bin/env python3
"""test_rules_index.py — standing guard over the ONE indexable rule
destination, ``www/rules/index.html``.

WHY THIS EXISTS. T-VHCRAWL.1 collapsed the indexable rule surface from 297 URLs
to a handful, which made this single page the only rule URL the sitemap asks
Google to index AND the only place a support reply, a forum answer or a CI log
can deep-link into. A list of links cannot do that job: it has no per-rule
anchor and it answers only "which rules exist". T-VHCRAWL.2/.4 turned it into a
real reference table with one anchored row per rule. This file is what stops
that regressing — silently losing an anchor, drifting from the catalog, or
growing a ``<script>``.

WHAT IT ASSERTS, reading the GENERATED page on disk and deriving EVERY
expectation from ``remediation_catalog.json`` at run time (there is no rule-id
list, severity list or location list typed into this file):

  1. the set of table-row ``id`` attributes equals EXACTLY the set of catalog
     rule ids — no missing row, no extra row, no duplicate id — and no row id
     collides with any other ``id`` on the page (a duplicate id makes the
     browser's fragment target ambiguous, i.e. the deep link silently lands on
     the wrong element);
  2. every row's rule cell links to that rule's OWN page, at the relative path
     ``<rule-id>/index.html``, and that file really exists in the tree;
  3. every row's severity / profile / BT-BG-terms / XML-location cells equal the
     catalog's values for that rule. Severity, terms and location are compared
     verbatim against the catalog; the profile is re-derived HERE from
     ``provenance.source`` through an explicit source->profile map (see
     :data:`_SOURCE_PROFILE`) rather than imported from the generator, so this
     is an independent check of the generator's derivation and not a restatement
     of it. A ``provenance.source`` this file has not been taught FAILS — which
     is the point: an unmapped source means nobody has decided what profile the
     page should print;
  4. the page carries exactly ONE ``<script>`` element and it is the
     ``application/ld+json`` structured-data block — the rule index is
     inline-CSS-only by design and must never grow JavaScript.

Plus a self-test (:func:`_self_test`) that feeds the row parser and the cell
comparator deliberately-broken markup and asserts they report it. A guard that
can only ever pass is not a guard.

Standard library only. No network, no pip, no build; reads the committed tree
and finishes in well under a second.

    python3 test_rules_index.py
"""

from __future__ import annotations

import html as _html
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WWW_DIR = os.path.join(HERE, "www")
RULES_DIR = os.path.join(WWW_DIR, "rules")
HUB_PATH = os.path.join(RULES_DIR, "index.html")
CATALOG_PATH = os.path.join(HERE, "remediation_catalog.json")

# Column HEADINGS the table is expected to carry, mapped to the catalog field
# each column renders. Column ORDER is not assumed anywhere: the index of each
# column is read from the table's own <thead> row at run time, so re-ordering
# the table is not a failure while dropping or renaming a column is.
_RULE_COL = "Rule"
_COL_FIELDS = {
    "Requirement": "title",
    "Severity": "severity",
    "BT/BG terms": "bt_bg",
    "XML location": "location_hint",
    # "Profile" is derived, not a catalog field — handled separately below.
}
_PROFILE_COL = "Profile"

# Independent source->profile map. The generator derives the profile by
# splitting provenance.source on the first "-"; this file states the mapping
# explicitly instead, so the two disagree loudly if either is changed alone.
# A source that is absent from this map fails rather than defaulting.
_SOURCE_PROFILE = {
    "en16931-ubl": "en16931",
    "xrechnung-ubl": "xrechnung",
    "xrechnung-cii": "xrechnung",
}

# Placeholder the generator prints for an empty cell (BT/BG terms can be empty).
_EMPTY_CELL = "—"          # em dash

# --- matchers ---------------------------------------------------------------
# A data row: <tr id="..."> ... </tr>. Rows are emitted one per line, but the
# match is not line-anchored so a reflow would not silently blind this guard.
_ROW_RE = re.compile(r'<tr\b[^>]*\bid="([^"]*)"[^>]*>(.*?)</tr>', re.S)
# The <thead> header row of a table (no id attribute, <th scope="col"> cells).
_THEAD_RE = re.compile(r"<thead>\s*<tr\b[^>]*>(.*?)</tr>\s*</thead>", re.S)
_CELL_RE = re.compile(r"<t([hd])\b[^>]*>(.*?)</t\1>", re.S)
_ANY_ID_RE = re.compile(r'\bid="([^"]*)"')
_HREF_RE = re.compile(r'\bhref="([^"]*)"')
_SCRIPT_OPEN_RE = re.compile(r"<script\b[^>]*>", re.I)
_TAG_RE = re.compile(r"<[^>]+>")


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def _text(fragment):
    """Visible text of an HTML fragment: tags stripped, entities unescaped."""
    return " ".join(_html.unescape(_TAG_RE.sub(" ", fragment)).split())


def _catalog_rules():
    """``rule_id -> entry`` straight from the committed remediation catalog."""
    with open(CATALOG_PATH, encoding="utf-8") as fh:
        return json.load(fh)["rules"]


def _expected_cells(rule_id, entry):
    """Expected visible text of each guarded column, DERIVED from the catalog.

    Returns ``(cells, error)``: ``cells`` maps column heading -> expected text,
    ``error`` is a message when the entry cannot be mapped (unknown provenance
    source) and None otherwise.
    """
    source = (entry.get("provenance") or {}).get("source") or ""
    if source not in _SOURCE_PROFILE:
        return {}, ("rule %s carries provenance.source %r, which this guard has "
                    "no profile for — decide what the rule index should print "
                    "and add it to _SOURCE_PROFILE" % (rule_id, source))
    terms = ", ".join(entry.get("bt_bg") or []) or _EMPTY_CELL
    cells = {
        "Requirement": entry.get("title", ""),
        "Severity": entry.get("severity", ""),
        "Profile": _SOURCE_PROFILE[source],
        "BT/BG terms": terms,
        "XML location": entry.get("location_hint", "") or _EMPTY_CELL,
    }
    # Compare against WHITESPACE-NORMALISED catalog text: _text() collapses runs
    # of whitespace when it reads the cell back out of the HTML, so the expected
    # side has to be collapsed the same way or a catalog title containing a
    # newline would read as a mismatch that is really just markup reflow.
    return {k: " ".join(v.split()) for k, v in cells.items()}, None


def header_columns(page):
    """Column heading -> index, read from the page's own first ``<thead>`` row.

    Every family table in the page repeats the same header row; this returns the
    first one and :func:`main` asserts the rest are identical, so column order is
    discovered rather than assumed.
    """
    out = []
    for block in _THEAD_RE.findall(page):
        out.append([_text(body) for _kind, body in _CELL_RE.findall(block)])
    return out


def parse_rows(page):
    """``[(row_id, [cell_text, ...]), ...]`` for every ``<tr id=...>`` data row.

    Pure and fragment-friendly so :func:`_self_test` can drive it with planted
    markup instead of a file.
    """
    rows = []
    for row_id, body in _ROW_RE.findall(page):
        cells = [_text(cell) for _kind, cell in _CELL_RE.findall(body)]
        rows.append((row_id, cells))
    return rows


def row_links(page):
    """``row_id -> [href, ...]`` for every data row (the link check's input)."""
    return {row_id: _HREF_RE.findall(body)
            for row_id, body in _ROW_RE.findall(page)}


def cell_mismatches(row_id, cells, columns, expected):
    """Guarded columns whose rendered text differs from the catalog-derived one.

    Returns a list of ``(column, got, want)``. Pure, so the self-test can prove
    it fires.
    """
    bad = []
    for col, want in sorted(expected.items()):
        idx = columns.get(col)
        if idx is None or idx >= len(cells):
            bad.append((col, "<missing cell>", want))
            continue
        got = cells[idx]
        if got != want:
            bad.append((col, got, want))
    return bad


def _self_test(fail):
    """Prove the parser and the comparator FAIL on bad input (anti-vacuity)."""
    planted = ('<tr id="BR-X"><th scope="row"><a href="BR-X/index.html">'
               "<code>BR-X</code></a></th><td>Title</td><td>fatal</td></tr>")
    rows = parse_rows(planted)
    if rows != [("BR-X", ["BR-X", "Title", "fatal"])]:
        fail("SELF-TEST: parse_rows() returned %r for a known-good row — the "
             "row/cell extraction is broken, so every check below is vacuous"
             % (rows,))
    if row_links(planted) != {"BR-X": ["BR-X/index.html"]}:
        fail("SELF-TEST: row_links() did not extract the rule-page href — the "
             "link check is vacuous")
    if parse_rows("<tr><td>no id here</td></tr>"):
        fail("SELF-TEST: parse_rows() matched a row with no id attribute — the "
             "anchor check would pass on an unanchored table")

    cols = {"Severity": 2}
    if cell_mismatches("BR-X", ["BR-X", "Title", "warning"], cols,
                       {"Severity": "fatal"}) != [("Severity", "warning",
                                                   "fatal")]:
        fail("SELF-TEST: cell_mismatches() did not flag a planted wrong "
             "severity — the cell comparison is vacuous")
    if cell_mismatches("BR-X", ["BR-X", "Title", "fatal"], cols,
                       {"Severity": "fatal"}):
        fail("SELF-TEST: cell_mismatches() flagged a correct cell — the cell "
             "comparison is over-firing")
    if not cell_mismatches("BR-X", ["BR-X"], cols, {"Severity": "fatal"}):
        fail("SELF-TEST: cell_mismatches() did not flag a missing cell")


def main():
    failures = []

    def fail(msg):
        failures.append(msg)

    if not os.path.isfile(HUB_PATH):
        print("FAIL: %s not found — run gen_site.py first" % HUB_PATH)
        return 1

    _self_test(fail)

    page = _read(HUB_PATH)
    catalog = _catalog_rules()

    # Vacuity guard: an empty or tiny catalog must not read as a clean run.
    if len(catalog) < 100:
        print("FAIL: remediation_catalog.json yielded %d rules — the catalog "
              "read is broken" % len(catalog))
        return 1

    # ---- column discovery -------------------------------------------------
    headers = header_columns(page)
    if not headers:
        fail("no <thead> header row found on the rule index — the page is not "
             "a real table, or the header cells lost their <th> markup")
        columns = {}
    else:
        if any(h != headers[0] for h in headers[1:]):
            fail("the %d family tables do not share one header row: %r"
                 % (len(headers), headers))
        columns = {name: i for i, name in enumerate(headers[0])}
        for needed in [_RULE_COL, _PROFILE_COL] + sorted(_COL_FIELDS):
            if needed not in columns:
                fail("the rule table has no %r column (headers: %r) — the "
                     "guarded fact is no longer rendered"
                     % (needed, headers[0]))
        # <th scope="col"> on the header cells is what makes the table readable
        # to a screen reader; assert it rather than trusting the visible text.
        for block in _THEAD_RE.findall(page):
            kinds = {kind for kind, _body in _CELL_RE.findall(block)}
            if kinds != {"h"}:
                fail("a header row uses %r cells — header cells must be <th>"
                     % sorted(kinds))
            if block.count('scope="col"') != len(_CELL_RE.findall(block)):
                fail("a header row has a <th> without scope=\"col\"")

    # ---- (1) row anchors == catalog rule ids, uniquely --------------------
    rows = parse_rows(page)
    row_ids = [rid for rid, _cells in rows]
    dupes = sorted({r for r in row_ids if row_ids.count(r) > 1})
    if dupes:
        fail("duplicate row id(s) on the rule index: %r — a repeated id makes "
             "the deep link ambiguous" % dupes)
    got, want = set(row_ids), set(catalog)
    for rid in sorted(want - got):
        fail("catalog rule %s has no row on the rule index — it is not "
             "deep-linkable" % rid)
    for rid in sorted(got - want):
        fail("the rule index carries a row anchored at %s, which is not a "
             "catalog rule id" % rid)
    if len(row_ids) < 100:
        fail("only %d anchored rows found — the row extraction is broken"
             % len(row_ids))

    # No row id may collide with any OTHER id on the page (family section
    # anchors, etc.): a duplicate fragment target lands the reader elsewhere.
    all_ids = _ANY_ID_RE.findall(page)
    for rid in sorted(set(row_ids)):
        if all_ids.count(rid) != 1:
            fail("id %r appears %d times on the page (row anchor plus another "
                 "element) — the fragment target is ambiguous"
                 % (rid, all_ids.count(rid)))

    # ---- (2) every row links to that rule's own page ----------------------
    links = row_links(page)
    for rid in sorted(got & want):
        expected_href = "%s/index.html" % rid
        if expected_href not in links.get(rid, []):
            fail("row %s does not link to its own rule page %r (hrefs: %r)"
                 % (rid, expected_href, links.get(rid, [])))
        elif not os.path.isfile(os.path.join(RULES_DIR, rid, "index.html")):
            fail("row %s links to %r, which no generated file serves"
                 % (rid, expected_href))

    # ---- (3) guarded cells equal the catalog's values ---------------------
    # The "sample" is the WHOLE catalog: every rule is derived, so checking all
    # of them costs milliseconds and leaves no unguarded row.
    cells_by_id = dict(rows)
    checked = 0
    for rid in sorted(got & want):
        expected, err = _expected_cells(rid, catalog[rid])
        if err:
            fail(err)
            continue
        for col, cell_got, cell_want in cell_mismatches(
                rid, cells_by_id[rid], columns, expected):
            fail("row %s column %r renders %r but the catalog says %r"
                 % (rid, col, cell_got, cell_want))
        checked += 1

    # ---- (4) exactly one <script>, and it is the JSON-LD block ------------
    scripts = _SCRIPT_OPEN_RE.findall(page)
    if len(scripts) != 1:
        fail("the rule index carries %d <script> elements (%r) — it must carry "
             "exactly one, the JSON-LD block" % (len(scripts), scripts))
    for tag in scripts:
        if "application/ld+json" not in tag:
            fail("the rule index carries a non-JSON-LD script %r — this page "
                 "family is inline-CSS-only and must stay JavaScript-free"
                 % tag)

    if failures:
        print("RULES INDEX: FAIL (%d)" % len(failures))
        for msg in failures[:40]:
            print("  !! %s" % msg)
        if len(failures) > 40:
            print("  ... and %d more" % (len(failures) - 40))
        return 1

    print("rules index OK: %d anchored rows == %d catalog rule ids (all "
          "unique, no id collision on the page); every row links to its own "
          "rule page; %d rows verified cell-by-cell against the catalog "
          "(%s); exactly one <script> and it is the JSON-LD block."
          % (len(row_ids), len(catalog), checked,
             ", ".join(sorted([_PROFILE_COL] + list(_COL_FIELDS)))))
    return 0


if __name__ == "__main__":
    sys.exit(main())

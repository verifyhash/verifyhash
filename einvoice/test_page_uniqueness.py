#!/usr/bin/env python3
"""test_page_uniqueness.py — standing guard that every URL this site ASKS to be
indexed is worth indexing: individually distinctive, and not a near-twin of
another URL in the same sitemap.

WHY THIS EXISTS. Every other site test in this repo asks "is this claim TRUE" —
test_site.py (byte-equality with the generator), test_www_claims.py (does the
prose match the engine), test_structured_data.py (does the JSON-LD describe the
page), test_link_graph.py (does every link resolve). None of them asks "is this
page WORTH PUBLISHING". That gap is how the near-duplicate class survived a
first cleanup: T-VHCRAWL.1 cut the indexable surface from 297 rule pages to 24
with a per-page distinctiveness FLOOR, but a floor is blind to SIBLINGS — a
page can be rich in rare vocabulary and still be a 95%-identical restatement of
the page next to it, because the rare tokens it carries are the same rare
tokens its sibling carries.

BASELINE MEASUREMENT THAT MOTIVATED THIS GUARD — run 335, gen_site's own
tokenizer, over the 24 pages the floor had kept, quoted verbatim:
"BR-AF-08/BR-AG-08/BR-S-08 at Jaccard 0.950-0.955, and
 BR-AE-08/BR-O-08/BR-IC-08/BR-Z-08 a full clique at 0.932-0.942, plus
 BR-CL-10/BR-CL-11 at 0.953."
Across all 276 pairs among those 24 pages the median was 0.474 and the minimum
0.333, so those clusters were not "siblings are similar" noise — they were 11
of 25 sitemap URLs sitting in three ~93%-identical groups, on a site that has
never earned a single Google-referred URL. T-VHCRAWL.3 added
``gen_site.RULE_PAGE_SIMILARITY_CEILING`` (0.85) to collapse each cluster to
one representative; this file is what stops the class coming back the next time
a rule family is generated.

WHAT IT ASSERTS, reading the GENERATED TREE under ``www/`` (not the
generator's in-memory idea of it):

  (1) every rule page listed in ``www/sitemap.xml`` scores at or above
      ``gen_site.RULE_PAGE_DISTINCTIVENESS_FLOOR``, where the score is
      recomputed here from the files on disk with gen_site's own tokenizer and
      document-frequency ratio over the whole 297-page rule family;
  (2) NO two sitemap-listed pages — rule or surface, any mix — have visible-text
      Jaccard similarity above ``gen_site.RULE_PAGE_SIMILARITY_CEILING``;
  (3) every rule page that is below the floor OR collapsed by the ceiling
      carries ``<meta name="robots" content="noindex,follow">`` and is ABSENT
      from the sitemap; and conversely every sitemap-listed rule page carries
      NO noindex directive. (The meta and the sitemap come from one predicate
      in the generator; this checks the artifact actually shipped that way.)
  (4) both constants are IMPORTED from ``gen_site`` — this file defines no copy
      of either, so the guard and the generator can never disagree about where
      the lines are.

Plus a self-test (:func:`_self_test`) that feeds the two checkers a
deliberately-bad page set and asserts they report the violation. A guard that
can only ever pass is not a guard; this makes the failure path executed on
every run, so the checks cannot silently rot into no-ops.

EXEMPTION (1) — SURFACE PAGES ARE NOT SCORED AGAINST THE FLOOR. The
distinctiveness score is defined relative to the 297-page rule FAMILY: a token
is "distinctive" when at most 10% of rule pages carry it. The eight hand-built
surface pages (landing, hub, walkthrough, licensing, compare, validate, German
landing, German walkthrough) are not members of that family and are not
generated from the rule catalog, so scoring them against a rule-family document
frequency measures nothing meaningful. They ARE fully subject to check (2), the
one that actually matters for them — and today they are nowhere near it: the
closest surface pair is walkthrough vs. its German twin at 0.328, and every
other surface pair is below 0.25.

There is no exemption from check (2) and no allowlist below it. If one is ever
needed it must be an explicit entry with a one-line reason; an undeclared
violation FAILS.

Standard library only. No network, no pip, no build. Reads the committed tree
and finishes in about a second.

    python3 test_page_uniqueness.py
"""

from __future__ import annotations

import itertools
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WWW_DIR = os.path.join(HERE, "www")
RULES_DIR = os.path.join(WWW_DIR, "rules")
SITEMAP_PATH = os.path.join(WWW_DIR, "sitemap.xml")

sys.path.insert(0, HERE)
import gen_site as _gen  # noqa: E402  (path set above)

# The two constants under guard, IMPORTED — never re-typed. If the generator
# retunes either line, this test moves with it automatically; a divergent copy
# here would be exactly the drift the test exists to prevent.
FLOOR = _gen.RULE_PAGE_DISTINCTIVENESS_FLOOR
CEILING = _gen.RULE_PAGE_SIMILARITY_CEILING

# The tokenizer and the rarity ratio are imported for the same reason: this
# file must measure what the generator measured, not something adjacent to it.
_visible_tokens = _gen._visible_tokens
_RARE_DF_RATIO = _gen._RULE_PAGE_RARE_DF_RATIO

# ---------------------------------------------------------------------------
# ALLOWLIST — pages EXEMPT from the distinctiveness FLOOR check (1) only.
#
# Rationale in full in the module docstring: the score is defined against the
# rule-page family's document frequency, and these eight pages are hand-built
# surface, not catalog-generated rule pages, so a rule-family score is not a
# meaningful number for them. Each remains fully subject to check (2), the
# pairwise ceiling.
#
# One line each, saying why the page is not a rule page:
_FLOOR_EXEMPT = {
    "index.html":                 "landing — hand-written product page",
    "rules/index.html":           "rule index hub — a navigational list, by design",
    "walkthrough/index.html":     "worked walkthrough — hand-written tutorial",
    "licensing/index.html":       "licensing terms — hand-written",
    "compare/index.html":         "comparison page — hand-written",
    "validate/index.html":        "in-browser validator — an application, not an article",
    "de/index.html":              "German landing — hand-written",
    "de/walkthrough/index.html":  "German walkthrough — hand-written tutorial",
}

# There is deliberately NO exemption list for the pairwise ceiling. Adding one
# would defeat the entire point of this file.

_LOC_RE = re.compile(r"<loc>(.*?)</loc>", re.S)
_ROBOTS_RE = re.compile(
    r'<meta\b[^>]*\bname="robots"[^>]*\bcontent="([^"]*)"', re.IGNORECASE)


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def _rel_for_url(url):
    """Site-relative file path a sitemap ``<loc>`` resolves to under ``www/``.

    Built from ``gen_site.BASE_URL`` — the same constant the generator uses for
    the ``<loc>`` and the canonical — so this cannot drift from the site.
    """
    base = _gen.BASE_URL.rstrip("/")
    if not url.startswith(base):
        raise ValueError("sitemap <loc> outside BASE_URL: %r" % url)
    tail = url[len(base):].lstrip("/")
    return tail + "index.html" if (tail == "" or tail.endswith("/")) else tail


def _sitemap_rels():
    """Site-relative paths of every ``<loc>`` in the generated sitemap."""
    return [_rel_for_url(u.strip()) for u in _LOC_RE.findall(_read(SITEMAP_PATH))]


def _rule_page_paths():
    """``rule_id -> www-relative path`` for every generated rule page."""
    out = {}
    for name in sorted(os.listdir(RULES_DIR)):
        page = os.path.join(RULES_DIR, name, "index.html")
        if os.path.isfile(page):
            out[name] = "rules/%s/index.html" % name
    return out


def distinctiveness_from_disk(rule_tokens):
    """``rule_id -> distinctive-token count``, computed over the whole family.

    ``rule_tokens`` maps rule id -> token set. A token is distinctive when its
    document frequency across the family is at most
    ``_RULE_PAGE_RARE_DF_RATIO`` of the family size — the generator's rule,
    re-applied to the bytes that actually shipped.
    """
    df = {}
    for toks in rule_tokens.values():
        for tok in toks:
            df[tok] = df.get(tok, 0) + 1
    limit = len(rule_tokens) * _RARE_DF_RATIO
    return {rid: sum(1 for tok in toks if df[tok] <= limit)
            for rid, toks in rule_tokens.items()}


def jaccard(a, b):
    """Set Jaccard similarity, with the empty/empty case pinned to 0.0."""
    union = a | b
    return len(a & b) / len(union) if union else 0.0


def floor_violations(sitemapped_rule_scores, floor):
    """Sitemapped rule pages scoring BELOW ``floor`` — the check-(1) failures.

    Split out as a pure function so :func:`_self_test` can prove it fires.
    """
    return sorted((rid, score) for rid, score in sitemapped_rule_scores.items()
                  if score < floor)


def ceiling_violations(page_tokens, ceiling):
    """Sitemapped page pairs ABOVE ``ceiling`` — the check-(2) failures.

    ``page_tokens`` maps a page label -> token set. Pure, so
    :func:`_self_test` can prove it fires on a planted duplicate.
    """
    bad = []
    for a, b in itertools.combinations(sorted(page_tokens), 2):
        sim = jaccard(page_tokens[a], page_tokens[b])
        if sim > ceiling:
            bad.append((sim, a, b))
    return sorted(bad, reverse=True)


def _self_test(fail):
    """Prove both checkers actually FAIL on bad input (anti-vacuity).

    Without this, a refactor that made ``ceiling_violations`` return ``[]``
    unconditionally — or a floor comparison accidentally inverted — would leave
    this file printing OK forever. The planted inputs are synthetic token sets,
    never files, so nothing under ``www/`` is touched.
    """
    twin_a = {"invoice", "vat", "category", "code", "bt-118", "shall"}
    twin_b = twin_a | {"bt-119"}            # Jaccard 6/7 = 0.857 > 0.85
    loner = {"pyodide", "browser", "wasm", "runtime", "offline", "bundle"}
    planted = ceiling_violations({"a": twin_a, "b": twin_b, "c": loner}, CEILING)
    if not any({a, b} == {"a", "b"} for _, a, b in planted):
        fail("SELF-TEST: ceiling_violations() did not flag a planted %.3f pair "
             "at ceiling %.2f — the pairwise check is vacuous"
             % (jaccard(twin_a, twin_b), CEILING))
    if any("c" in (a, b) for _, a, b in planted):
        fail("SELF-TEST: ceiling_violations() flagged a dissimilar page — the "
             "pairwise check is over-firing")

    planted = floor_violations({"OK": FLOOR, "LOW": FLOOR - 1}, FLOOR)
    if planted != [("LOW", FLOOR - 1)]:
        fail("SELF-TEST: floor_violations() at floor %d returned %r — expected "
             "exactly the sub-floor page; the floor check is vacuous or "
             "off-by-one" % (FLOOR, planted))


def main():
    failures = []

    def fail(msg):
        failures.append(msg)

    if not os.path.isdir(WWW_DIR) or not os.path.isfile(SITEMAP_PATH):
        print("FAIL: www/ or www/sitemap.xml not found — run gen_site.py first")
        return 1

    _self_test(fail)

    # ---- inputs, all read from the generated tree ------------------------
    rule_paths = _rule_page_paths()
    rule_tokens = {rid: _visible_tokens(_read(os.path.join(WWW_DIR, rel)))
                   for rid, rel in rule_paths.items()}
    scores = distinctiveness_from_disk(rule_tokens)

    sitemapped = _sitemap_rels()
    if len(sitemapped) != len(set(sitemapped)):
        fail("sitemap.xml lists the same page twice")
    sitemapped = set(sitemapped)

    # Vacuity guards: an empty walk or an unparsed sitemap must not read as a
    # clean run.
    if len(rule_tokens) < 100:
        fail("only %d rule pages found under www/rules — the walk is broken"
             % len(rule_tokens))
    if len(sitemapped) < 2:
        fail("sitemap.xml yielded %d <loc> entries — extraction is broken"
             % len(sitemapped))

    rel_to_rule = {rel: rid for rid, rel in rule_paths.items()}

    # ---- (1) every sitemapped RULE page clears the floor ------------------
    sitemapped_rule_scores = {rel_to_rule[rel]: scores[rel_to_rule[rel]]
                              for rel in sitemapped if rel in rel_to_rule}
    if not sitemapped_rule_scores:
        fail("no sitemapped rule pages at all — the collapse emptied the "
             "indexable rule surface, which is not the intended outcome")
    for rid, score in floor_violations(sitemapped_rule_scores, FLOOR):
        fail("rules/%s is listed in sitemap.xml but scores %d distinctive "
             "tokens, below the floor of %d — noindex it instead of "
             "publishing it" % (rid, score, FLOOR))

    # Non-rule sitemapped pages must each be a declared exemption; an
    # undeclared one (e.g. a new hand-built page) fails here rather than
    # silently escaping check (1).
    for rel in sorted(sitemapped - set(rel_to_rule)):
        if rel not in _FLOOR_EXEMPT:
            fail("%s is sitemapped but is neither a rule page nor a declared "
                 "floor exemption — add it to _FLOOR_EXEMPT with a reason, or "
                 "remove it from the sitemap" % rel)
    for rel in sorted(_FLOOR_EXEMPT):
        if rel not in sitemapped:
            fail("_FLOOR_EXEMPT lists %s, which the sitemap no longer contains "
                 "— drop the stale exemption" % rel)

    # ---- (2) no two sitemapped pages exceed the similarity ceiling --------
    page_tokens = {}
    for rel in sorted(sitemapped):
        path = os.path.join(WWW_DIR, rel)
        if not os.path.isfile(path):
            fail("sitemap lists %s, which no generated file serves" % rel)
            continue
        page_tokens[rel] = (rule_tokens[rel_to_rule[rel]]
                            if rel in rel_to_rule else _visible_tokens(_read(path)))
    for sim, a, b in ceiling_violations(page_tokens, CEILING):
        fail("%s and %s are %.3f similar (visible-text Jaccard), above the "
             "ceiling of %.2f — both are sitemapped, so we are asking Google "
             "to index two copies of one page; collapse the cluster in "
             "gen_site.indexable_rule_ids()" % (a, b, sim, CEILING))

    # ---- (3) noindex <=> not sitemapped, over every rule page -------------
    for rid, rel in sorted(rule_paths.items()):
        page = _read(os.path.join(WWW_DIR, rel))
        robots = _ROBOTS_RE.search(page)
        noindex = bool(robots and "noindex" in robots.group(1).lower())
        in_sitemap = rel in sitemapped
        if in_sitemap and noindex:
            fail("rules/%s carries robots %r yet is listed in sitemap.xml — "
                 "the meta and the sitemap disagree"
                 % (rid, robots.group(1)))
        if not in_sitemap and not noindex:
            fail("rules/%s is absent from sitemap.xml but carries no "
                 "noindex directive — a page excluded from the indexable "
                 "surface must say so on the page too" % rid)
        # The directive must keep link equity flowing (T-VHCRAWL.1's choice).
        if noindex and "nofollow" in robots.group(1).lower():
            fail("rules/%s uses nofollow; the excluded pages must stay "
                 "'noindex,follow' so links keep flowing" % rid)

    # ---- (4) the constants really came from gen_site ----------------------
    if FLOOR is not _gen.RULE_PAGE_DISTINCTIVENESS_FLOOR or \
            CEILING is not _gen.RULE_PAGE_SIMILARITY_CEILING:
        fail("the constants under test are not gen_site's own objects")
    if not 0.0 < CEILING < 1.0:
        fail("RULE_PAGE_SIMILARITY_CEILING=%r is not a similarity in (0, 1)"
             % CEILING)

    if failures:
        print("PAGE UNIQUENESS: FAIL (%d)" % len(failures))
        for msg in failures[:40]:
            print("  !! %s" % msg)
        if len(failures) > 40:
            print("  ... and %d more" % (len(failures) - 40))
        return 1

    sims = [jaccard(page_tokens[a], page_tokens[b])
            for a, b in itertools.combinations(sorted(page_tokens), 2)]
    noindexed = len(rule_paths) - len(sitemapped_rule_scores)
    print("page uniqueness OK: %d rule pages on disk, %d sitemapped (%d rule "
          "+ %d declared surface); every sitemapped rule page >= floor %d "
          "(min %d); worst sitemapped pair %.3f <= ceiling %.2f (median %.3f "
          "over %d pairs); %d rule pages excluded and every one carries "
          "noindex,follow."
          % (len(rule_paths), len(sitemapped), len(sitemapped_rule_scores),
             len(sitemapped) - len(sitemapped_rule_scores), FLOOR,
             min(sitemapped_rule_scores.values()), max(sims), CEILING,
             sorted(sims)[len(sims) // 2], len(sims), noindexed))
    return 0


if __name__ == "__main__":
    sys.exit(main())

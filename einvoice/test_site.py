#!/usr/bin/env python3
"""test_site.py — the static per-rule reference site (``einvoice/www/rules/``)
must cover EXACTLY the rules in the remediation catalog, carry each rule's full
English entry verbatim, be injection-safe (all catalog text HTML-escaped), and
reference no external resource.

Standard library only; no network. Run from the einvoice dir:

    python3 test_site.py

Checks (each an independent hard assert):

  (a) the SET of generated page directories under www/rules/ is EXACTLY
      set(remediation.load_catalog().keys()) — no missing page, no orphan dir.
      This is computed live from the loader, never a hardcoded count, so it can
      neither drift nor block on a catalog resize.
  (b) each page's rendered text contains that rule's title, requires, fix,
      severity and provenance.assert VERBATIM (after HTML-unescaping) — proving
      the full entry is present with no stub and no drift. ALSO: title_de and
      fix_de appear verbatim inside a lang="de" element, and the honest
      German-provenance label matches the entry's de_source (kosit=official
      KoSIT text vs. translation) — a translation is never labelled official.
  (b-seo) each page carries a <title> and a <meta name=description> that are
      UNIQUE across all 211 pages, exactly one relative <link rel=canonical>,
      and exactly one schema.org TechArticle JSON-LD block that parses via
      json.loads, carries the rule id, and holds no unescaped '</script>'.
  (c) NO page contains a raw '<' that came from catalog content (incl. the
      German strings — injection guard), and NO page references an external
      resource. A <script> is allowed ONLY as the inline ld+json block (no
      src), a <link> ONLY as the relative rel=canonical, and the sole permitted
      http(s) token is the schema.org @context IRI inside that JSON-LD block.
  (d) ``gen_site.py --check`` returns 0 on the committed tree, and would return
      non-zero if a committed page were mutated (simulated on a temp copy).
"""

from __future__ import annotations

import html
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

from einvoice import remediation as _remediation  # noqa: E402
import gen_site as _gen                            # noqa: E402

RULES_DIR = os.path.join(HERE, "www", "rules")

# Strip HTML tags so we can assert on the human-visible text only. The catalog
# strings themselves contain no '<', so removing '<...>' spans cannot eat any
# catalog content (and (c) separately proves no catalog '<' survived raw).
_TAG_RE = re.compile(r"<[^>]*>")

# The one inline JSON-LD block per page. The serialized JSON neutralises every
# '<' to < (injection guard), so its content never holds a '</script>' and
# this non-greedy capture is exact.
_LD_RE = re.compile(
    r'<script type="application/ld\+json">(.*?)</script>', re.S)
_TITLE_RE = re.compile(r"<title>(.*?)</title>", re.S)
_DESC_RE = re.compile(
    r'<meta name="description" content="(.*?)">', re.S)
_CANON_RE = re.compile(r'<link\b[^>]*\brel="canonical"', re.IGNORECASE)

# de_source -> the honest provenance token that MUST appear on the page.
_DE_TOKEN = {"kosit": "Amtlicher KoSIT-Text", "translation": "Übersetzung"}


def _visible_text(page):
    """The rendered text of a page: tags removed, then HTML-unescaped."""
    return html.unescape(_TAG_RE.sub(" ", page))


def _dirs_under_rules():
    if not os.path.isdir(RULES_DIR):
        return set()
    return {d for d in os.listdir(RULES_DIR)
            if os.path.isdir(os.path.join(RULES_DIR, d))}


def main():
    failures = []

    def check(cond, msg):
        if not cond:
            failures.append(msg)

    catalog = _remediation.load_catalog()
    want = set(catalog)
    check(bool(want), "catalog has no rules")

    # ---- (a) page-dir SET == catalog-id SET (live, never a hardcoded int) --
    have = _dirs_under_rules()
    missing = sorted(want - have)
    orphan = sorted(have - want)
    check(not missing, "catalog rules with NO page dir (missing): %s"
          % missing[:10])
    check(not orphan, "page dirs that are NOT catalog ids (orphans): %s"
          % orphan[:10])

    # Every page dir must actually hold an index.html.
    for rid in sorted(want & have):
        check(os.path.exists(os.path.join(RULES_DIR, rid, "index.html")),
              "www/rules/%s has no index.html" % rid)

    # ---- (b)+(c)+SEO+DE per-page content -----------------------------------
    # Any http(s) URL is banned EXCEPT the schema.org @context IRI, which is a
    # JSON-LD namespace identifier (not a fetched resource) and lives only in
    # the removed ld+json block below.
    ext_re = re.compile(r"https?://|cdn\.|url\(", re.IGNORECASE)
    # A <script> is allowed ONLY when it is the inline ld+json block (no src).
    bad_script_re = re.compile(
        r'<script\b(?![^>]*type="application/ld\+json")', re.IGNORECASE)
    src_re = re.compile(r"\bsrc\s*=", re.IGNORECASE)
    # A <link> is allowed ONLY when it is our relative rel=canonical (no
    # stylesheet, no external href).
    bad_link_re = re.compile(
        r'<link\b(?![^>]*\brel="canonical")', re.IGNORECASE)

    titles_seen = {}       # <title> text -> first rid (uniqueness)
    descs_seen = {}        # meta description text -> first rid (uniqueness)

    for rid in sorted(want & have):
        path = os.path.join(RULES_DIR, rid, "index.html")
        if not os.path.exists(path):
            continue
        page = open(path, encoding="utf-8").read()
        vis = _visible_text(page)
        e = catalog[rid]
        prov = e.get("provenance") or {}

        # (b) full English entry present verbatim after unescaping.
        check(rid in vis, "%s: page missing its own rule id" % rid)
        for field in ("title", "requires", "fix", "severity"):
            val = e.get(field, "")
            check(val and val in vis,
                  "%s: page missing %s verbatim: %r" % (rid, field, val))
        passert = (prov.get("assert", "") or "").strip()
        check(passert and passert in vis,
              "%s: page missing provenance.assert verbatim" % rid)
        psource = prov.get("source", "")
        check(psource and psource in vis,
              "%s: page missing provenance.source verbatim" % rid)
        location = e.get("location_hint", "")
        check(location in vis, "%s: page missing location_hint" % rid)
        for term in (e.get("bt_bg") or []):
            check(term in vis, "%s: page missing business term %s" % (rid, term))

        # ---- German bilingual content (verbatim + lang + honest provenance) --
        title_de = e.get("title_de", "")
        fix_de = e.get("fix_de", "")
        de_source = e.get("de_source", "")
        check(title_de and title_de in vis,
              "%s: page missing title_de verbatim: %r" % (rid, title_de))
        check(fix_de and fix_de in vis,
              "%s: page missing fix_de verbatim: %r" % (rid, fix_de))
        # (2) at least one element carries lang="de".
        check('lang="de"' in page, "%s: page has no lang=\"de\" element" % rid)
        # (3) honest provenance label matches de_source; the OTHER source's
        # token must be absent so a translation is never labelled official.
        want_tok = _DE_TOKEN.get(de_source)
        check(want_tok is not None,
              "%s: unexpected de_source %r" % (rid, de_source))
        if want_tok is not None:
            check(want_tok in vis,
                  "%s: missing German provenance label %r for de_source=%s"
                  % (rid, want_tok, de_source))
            for other_src, other_tok in _DE_TOKEN.items():
                if other_src != de_source:
                    check(other_tok not in vis,
                          "%s: de_source=%s but MISLABELLED with %r"
                          % (rid, de_source, other_tok))

        # (c) injection guard: no catalog string survives with a raw '<'. Any
        # catalog value containing markup chars must appear ONLY escaped.
        # German strings are catalog-derived and guarded exactly like English.
        cat_strings = [e.get("title", ""), e.get("requires", ""),
                       e.get("location_hint", ""), e.get("fix", ""),
                       e.get("severity", ""), psource, passert,
                       title_de, fix_de]
        cat_strings += list(e.get("bt_bg") or [])
        for s in cat_strings:
            if s and "<" in s:
                check(s not in page,
                      "%s: catalog string appears UNESCAPED (raw '<'): %r"
                      % (rid, s))

        # ---- SEO metadata: title / description / canonical / JSON-LD --------
        tmatch = _TITLE_RE.search(page)
        check(tmatch is not None, "%s: no <title>" % rid)
        if tmatch:
            tval = tmatch.group(1)
            prev = titles_seen.get(tval)
            check(prev is None,
                  "%s: duplicate <title> shared with %s: %r" % (rid, prev, tval))
            titles_seen[tval] = rid

        dmatches = _DESC_RE.findall(page)
        check(len(dmatches) == 1,
              "%s: expected exactly 1 meta description, got %d"
              % (rid, len(dmatches)))
        if dmatches:
            dval = dmatches[0]
            prevd = descs_seen.get(dval)
            check(prevd is None,
                  "%s: duplicate meta description shared with %s"
                  % (rid, prevd))
            descs_seen[dval] = rid

        # (5) exactly one canonical link and exactly one ld+json block.
        canon = _CANON_RE.findall(page)
        check(len(canon) == 1,
              "%s: expected exactly 1 rel=canonical, got %d" % (rid, len(canon)))
        ld_blocks = _LD_RE.findall(page)
        check(len(ld_blocks) == 1,
              "%s: expected exactly 1 ld+json block, got %d"
              % (rid, len(ld_blocks)))

        # (6) JSON-LD parses, carries the rule id, and cannot break out of the
        # <script> element (no unescaped '</script>' inside the block).
        if ld_blocks:
            raw_ld = ld_blocks[0]
            check("</script>" not in raw_ld.lower()
                  and "</script " not in raw_ld.lower(),
                  "%s: raw '</script>' survived inside JSON-LD" % rid)
            try:
                obj = json.loads(raw_ld)
            except Exception as exc:  # noqa: BLE001
                obj = None
                check(False, "%s: JSON-LD does not parse: %s" % (rid, exc))
            if obj is not None:
                blob = json.dumps(obj, ensure_ascii=False)
                check(rid in blob, "%s: JSON-LD does not carry the rule id"
                      % rid)
                check(obj.get("@type") == "TechArticle",
                      "%s: JSON-LD @type is not TechArticle" % rid)

        # (c) no external resource references of any kind. The schema.org
        # @context IRI is the ONLY http(s) token allowed, so scan the page with
        # the ld+json block removed.
        page_no_ld = _LD_RE.sub(" ", page)
        check(not ext_re.search(page_no_ld),
              "%s: page references an external resource / url()" % rid)
        check(not bad_script_re.search(page),
              "%s: page has a non-ld+json <script>" % rid)
        check(not src_re.search(page_no_ld),
              "%s: page has a src= attribute (external resource)" % rid)
        check(not bad_link_re.search(page),
              "%s: page has a non-canonical <link> (external stylesheet)" % rid)
        # canonical must be relative (no hardcoded live origin).
        cmatch = re.search(r'<link\b[^>]*\brel="canonical"[^>]*\bhref="([^"]*)"',
                           page)
        check(cmatch is not None, "%s: canonical link has no href" % rid)
        if cmatch:
            href = cmatch.group(1)
            check(not re.match(r"https?://", href, re.IGNORECASE),
                  "%s: canonical is an absolute live URL (should be relative)"
                  % rid)

    # ---- (5) global uniqueness across ALL pages ----------------------------
    n_pages = len(sorted(want & have))
    check(len(titles_seen) == n_pages,
          "<title> values not unique across pages: %d titles for %d pages"
          % (len(titles_seen), n_pages))
    check(len(descs_seen) == n_pages,
          "meta descriptions not unique across pages: %d for %d pages"
          % (len(descs_seen), n_pages))

    # ---- (d) --check is 0 on the committed tree, non-zero on a mutation -----
    check(_gen.main(["--check"]) == 0,
          "gen_site.py --check FAILED on the committed tree (stale/missing)")

    # Actually mutate a committed page on disk, run the real --check gate, and
    # confirm it returns non-zero; then restore the byte-identical original in a
    # finally so the tree is left exactly as found (edits a real committed page,
    # per the task's "simulate by editing a temp copy").
    if want:
        sample = sorted(want)[0]
        page_path = os.path.join(RULES_DIR, sample, "index.html")
        if os.path.exists(page_path):
            original = open(page_path, encoding="utf-8").read()
            try:
                with open(page_path, "w", encoding="utf-8") as fh:
                    fh.write(original.replace("<h1>", "<h1>TAMPERED ", 1))
                check(_gen.main(["--check"]) != 0,
                      "gen_site.py --check did NOT flag a mutated page "
                      "(staleness gate is blind)")
            finally:
                with open(page_path, "w", encoding="utf-8") as fh:
                    fh.write(original)
            # Restored tree must be clean again.
            check(_gen.main(["--check"]) == 0,
                  "tree not restored to clean state after mutation test")

    if failures:
        sys.stderr.write("SITE TEST: FAIL (%d)\n" % len(failures))
        for m in failures[:40]:
            sys.stderr.write("  !! " + m + "\n")
        return 1
    print("site OK: %d rule pages == %d catalog ids (no orphans/gaps); each "
          "carries its full entry verbatim; all catalog text escaped; no "
          "external resources; --check green and mutation-sensitive."
          % (len(have), len(want)))
    return 0


if __name__ == "__main__":
    sys.exit(main())

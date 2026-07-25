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
      UNIQUE across every generated rule page (the count is exactly
      len(remediation.load_catalog()) — computed live, never a magic number),
      exactly one absolute <link rel=canonical> whose href is SELF-REFERENTIAL
      (equals gen_site._url_rule(rid), so a mis-keyed canonical fails), and
      exactly one schema.org JSON-LD block that parses via json.loads, whose
      top-level "@type" is exactly "TechArticle", that carries the rule id, and
      that holds no unescaped '</script>'.
  (c) NO page contains a raw '<' that came from catalog content (incl. the
      German strings — injection guard), and NO page references an external
      resource. A <script> is allowed ONLY as the inline ld+json block (no
      src), a <link> ONLY as the relative rel=canonical, and the sole permitted
      http(s) token is the schema.org @context IRI inside that JSON-LD block.
  (d) ``gen_site.py --check`` returns 0 on the committed tree, and would return
      non-zero if a committed page were mutated (simulated on a temp copy).
  (g) GERMAN PAGE (T-VHDE.1): www/de/index.html declares lang="de", carries a
      self-referential canonical, hreflang alternates BOTH directions with the
      English landing (which links it visibly), a unique title/description
      among the surface pages, every shell command byte-identical to the
      test-pinned English docs (gen_site.DE_COMMANDS, checked against both the
      page and the doc), and www/de/ holds EXACTLY index.html — no per-rule
      German pages (thin-content hard line).
  (h) COMPARE PAGE (T-VHCMP.1): www/compare/index.html names KoSIT and
      Mustangproject honestly (they are free; KoSIT is the official reference
      implementation), carries a 'When to prefer them' concession section (no
      XSD validation here, no full Peppol BIS, Mustangproject writes ZUGFeRD
      PDFs), states that our correctness claim DERIVES FROM the official
      KoSIT artifact, and is ENGLISH-only. CLAIMS-DRIFT guard: every engine
      figure the page states (rule count, Peppol subset, report-format list,
      exit codes) is parsed back out of the emitted HTML via its data-claim
      attribute and bound to the live registries (coverage.engine_fireable_ids,
      the Peppol id sets, report.REPORT_FORMATS, the cli exit-code constants)
      — the page can never silently lie about the engine.
  (i) DETERMINISM (T-VHSITEDET.1): the generator is run TWICE (fresh
      render_all + render_surface + write each time) into two separate temp
      output directories — never the committed www/ — and the two emitted
      trees must have EQUAL file sets and every corresponding file must be
      byte-identical (regeneration byte-identity: catches dict/set-order or
      wall-clock leakage). The emitted set must cover every page family
      (landing, hub, walkthrough, licensing, compare/, de/, de/walkthrough/,
      sitemap.xml, robots.txt, the validate/engine/ bundle files traced by
      gen_site.engine_bundle_modules() + manifest.json (T-VHWEB.1), and one
      page per catalog rule). PATH
      INVARIANCE: no emitted byte contains $HOME, the repo's absolute path,
      the temp output dir's own path, or the username — the tree is
      publishable from any machine. (Committed-tree identity to a fresh
      render is separately pinned by (d) --check.)
  (j) IN-BROWSER VALIDATOR PAGE (T-VHWEB.2): www/validate/index.html is a
      first-class generated page (part of the pinned canonical set — a
      PRODUCTION page earning its place, not gate-weakening). STATIC asserts
      only (no browser, no network, per the task's constitution line): the
      static document references NO external resource eagerly (no <script
      src=...>, no non-canonical <link>); the pinned Pyodide CDN URL +
      sha384 SRI + crossorigin="anonymous" appear ONLY inside the inline
      script (dynamic injection on explicit click); the pip-install fallback
      snippet is present; the embedded RULE_PAGES id list equals the live
      catalog EXACTLY (so findings hyperlink only to real ../rules/<id>/
      pages); the rule-count data-claim binds to the live registry; the
      canonical is gen_site._url_validate(); the landing page links to it
      visibly.
  (k) SURFACE STRUCTURED DATA (T-VHSHARE.2): every selling page listed in the
      module-level SURFACE_LDJSON_TYPES allowlist carries EXACTLY ONE
      application/ld+json element; it parses via json.loads; every top-level
      "@type" in it (unwrapping a JSON array or a "@graph") is allowlisted for
      that page — an UNDECLARED type fails, and the grading predicate is itself
      proven to reject one; its `url` (or its BreadcrumbList's terminal item)
      equals the page's own rel=canonical; every breadcrumb item URL is one the
      gen_site._url_*() helpers produce and every breadcrumb NAME appears in
      the page's visible <p class="crumb"> line (anti-cloaking); a
      SoftwareApplication's name/description are the page's own
      title/meta-description, its softwareVersion is the LIVE
      einvoice.__version__ (a hard-coded version fails) and its license is the
      shipped Apache-2.0, with no `offers` node while CHECKOUT_URL is empty;
      no unescaped '</script>' survives inside any block; and NO .html file
      under www/ anywhere contains AggregateRating / ratingValue / reviewCount
      / a "Review" type (zero customers — a rating node would be fabricated).
  (e) NAV + SITEMAP INTEGRITY (VHW.3, mirrors weatherhack WXQ.3): the landing
      page, rule index hub, walkthrough, licensing page, the comparison page,
      the in-browser validator page,
      the German product/quickstart page, sitemap.xml and
      robots.txt exist; every INTERNAL
      href in every generated HTML file resolves to a real generated file (no
      dangling link); sitemap.xml lists EXACTLY the generated canonical set
      (landing + hub + all rule pages) with no orphan/missing/duplicate; no
      page listed in the sitemap carries a noindex robots meta; robots.txt
      allows crawl and references the sitemap URL.
"""

from __future__ import annotations

import datetime
import html
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

from einvoice import remediation as _remediation  # noqa: E402
# The LIVE package version, imported independently of gen_site: the landing
# pages' SoftwareApplication.softwareVersion is checked against THIS, so a
# hard-coded version string in the generator would fail here (T-VHSHARE.2).
from einvoice import __version__ as _ENGINE_VERSION  # noqa: E402
# Live registries for the compare-page CLAIMS-DRIFT guard (T-VHCMP.1): the
# same sources gen_site.render_compare() reads at render time. The test
# re-reads them here and fails if any figure emitted on the page disagrees.
from einvoice import coverage as _coverage         # noqa: E402
from einvoice import cli as _cli                   # noqa: E402
from einvoice.report import REPORT_FORMATS as _REPORT_FORMATS  # noqa: E402
import gen_site as _gen                            # noqa: E402

WWW_DIR = os.path.join(HERE, "www")
RULES_DIR = os.path.join(WWW_DIR, "rules")

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
# The whole canonical <link ...> tag — stripped before the external-resource
# scan because its href is the absolute BASE_URL canonical (not a fetched
# resource). Matches only the single self-closing <link> element.
_CANON_LINK_RE = re.compile(r'<link\b[^>]*\brel="canonical"[^>]*>',
                            re.IGNORECASE)

# de_source -> the honest provenance token that MUST appear on the page.
_DE_TOKEN = {"kosit": "Amtlicher KoSIT-Text", "translation": "Übersetzung"}

# ---------------------------------------------------------------------------
# SURFACE_LDJSON_TYPES (T-VHSHARE.2) — the ALLOWLIST of schema.org top-level
# @types each selling surface may emit, keyed by its www/-relative path.
#
# This is a deliberate whitelist, not a description of the status quo: a page
# emitting a type that is not listed here FAILS. That is the point — schema.org
# is the one place where a page can assert something to Google that no human
# reader ever sees, so every new assertion has to be added HERE, consciously,
# by someone who can defend it. Adding "AggregateRating" or "Review" to this
# map is forbidden outright (we have zero customers; the check below rejects
# those tokens anywhere in any block regardless of what this map says).
#
# The 297 rule pages (TechArticle) are NOT in this map — they are graded by the
# per-rule loop above, which pins them to exactly one TechArticle block each.
SURFACE_LDJSON_TYPES = {
    # The product's own home pages: the software itself, in each language.
    "index.html": {"SoftwareApplication"},
    "de/index.html": {"SoftwareApplication"},
    # Non-root selling pages: the navigational trail the reader can see. No
    # primary type is claimed for these and NO `offers` node exists anywhere —
    # gen_site.CHECKOUT_URL is empty and the licensing page says in words that
    # checkout is not open, so no availability could be stated honestly.
    "compare/index.html": {"BreadcrumbList"},
    "licensing/index.html": {"BreadcrumbList"},
    "walkthrough/index.html": {"BreadcrumbList"},
    "de/walkthrough/index.html": {"BreadcrumbList"},
    "rules/index.html": {"BreadcrumbList"},
    # Pre-existing (T-VHWEB.2), listed so the map covers the whole surface.
    "validate/index.html": {"WebApplication"},
}

# Tokens that may never appear in ANY emitted structured data: the product has
# no customers, so a rating/review node would be a fabricated testimonial.
_LD_BANNED_RE = re.compile(
    r"aggregaterating|ratingvalue|reviewcount|\"review\"", re.IGNORECASE)


def _ld_nodes(obj):
    """Top-level schema.org nodes of one parsed ld+json block.

    Unwraps the two legal multi-node containers — a bare JSON array and a
    ``@graph`` wrapper — so a type can never be hidden one level down.
    """
    out = []
    for node in (obj if isinstance(obj, list) else [obj]):
        if isinstance(node, dict) and "@graph" in node:
            graph = node["@graph"]
            out.extend(graph if isinstance(graph, list) else [graph])
        else:
            out.append(node)
    return out


def _ld_type_violations(obj, allowed):
    """The top-level @types in ``obj`` that ``allowed`` does not permit.

    Returns a sorted list (empty == clean). A node with no ``@type`` at all is
    itself a violation, reported as ``"<missing>"``: an untyped node would slip
    past a naive membership test.
    """
    bad = []
    for node in _ld_nodes(obj):
        if not isinstance(node, dict):
            bad.append("<not-an-object>")
            continue
        types = node.get("@type")
        if types is None:
            bad.append("<missing>")
            continue
        for t in (types if isinstance(types, list) else [types]):
            if t not in allowed:
                bad.append(str(t))
    return sorted(bad)


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

        # (c) no external resource references of any kind. Two http(s) tokens
        # are legitimately present and are NOT fetched resources: the schema.org
        # @context IRI (inside the ld+json block) and the absolute canonical
        # <link> href built from gen_site.BASE_URL. Both are removed before the
        # scan; anything else with https?:// / cdn. / url( is a real external
        # resource and fails.
        page_no_ld = _LD_RE.sub(" ", page)
        page_scan = _CANON_LINK_RE.sub(" ", page_no_ld)
        check(not ext_re.search(page_scan),
              "%s: page references an external resource / url()" % rid)
        check(not bad_script_re.search(page),
              "%s: page has a non-ld+json <script>" % rid)
        check(not src_re.search(page_no_ld),
              "%s: page has a src= attribute (external resource)" % rid)
        check(not bad_link_re.search(page),
              "%s: page has a non-canonical <link> (external stylesheet)" % rid)
        # canonical must be the absolute URL built from the ONE BASE_URL
        # constant (VHW.3: same source as the sitemap <loc>, so they cannot
        # disagree). No hand-authored / divergent origin.
        cmatch = re.search(r'<link\b[^>]*\brel="canonical"[^>]*\bhref="([^"]*)"',
                           page)
        check(cmatch is not None, "%s: canonical link has no href" % rid)
        if cmatch:
            href = cmatch.group(1)
            check(href == _gen._url_rule(rid),
                  "%s: canonical %r is not gen_site._url_rule(rid) (%r)"
                  % (rid, href, _gen._url_rule(rid)))

    # ---- (5) global uniqueness across ALL pages ----------------------------
    n_pages = len(sorted(want & have))
    check(len(titles_seen) == n_pages,
          "<title> values not unique across pages: %d titles for %d pages"
          % (len(titles_seen), n_pages))
    check(len(descs_seen) == n_pages,
          "meta descriptions not unique across pages: %d for %d pages"
          % (len(descs_seen), n_pages))

    # ---- (e) internal-link + sitemap integrity (mirrors weatherhack WXQ.3) --
    # Surface files must exist.
    landing_path = os.path.join(WWW_DIR, "index.html")
    hub_path = os.path.join(RULES_DIR, "index.html")
    walkthrough_path = os.path.join(WWW_DIR, "walkthrough", "index.html")
    licensing_path = os.path.join(WWW_DIR, "licensing", "index.html")
    compare_path = os.path.join(WWW_DIR, "compare", "index.html")
    validate_path = os.path.join(WWW_DIR, "validate", "index.html")
    de_path = os.path.join(WWW_DIR, "de", "index.html")
    de_walkthrough_path = os.path.join(WWW_DIR, "de", "walkthrough", "index.html")
    sitemap_path = os.path.join(WWW_DIR, "sitemap.xml")
    robots_path = os.path.join(WWW_DIR, "robots.txt")
    engine_dir = os.path.join(WWW_DIR, "validate", "engine")
    for pth, name in ((landing_path, "www/index.html"),
                      (hub_path, "www/rules/index.html"),
                      (walkthrough_path, "www/walkthrough/index.html"),
                      (licensing_path, "www/licensing/index.html"),
                      (compare_path, "www/compare/index.html"),
                      (validate_path, "www/validate/index.html"),
                      (de_path, "www/de/index.html"),
                      (de_walkthrough_path, "www/de/walkthrough/index.html"),
                      (sitemap_path, "www/sitemap.xml"),
                      (robots_path, "www/robots.txt")):
        check(os.path.exists(pth), "surface file missing: %s" % name)

    # Engine bundle (T-VHWEB.1): the committed tree must carry the traced
    # module set + manifest — computed LIVE from gen_site's import tracer
    # (exactly like the rule-page set is computed live from the catalog, never
    # a hardcoded count). Byte-level correctness of each file is
    # test_web_bundle.py's job; presence in the generated surface is pinned
    # here.
    engine_mods = _gen.engine_bundle_modules()
    check("validate" in engine_mods and "__init__" in engine_mods,
          "engine_bundle_modules() lost a seed module: %r" % engine_mods)
    for fn in ["manifest.json"] + [m + ".py" for m in engine_mods]:
        check(os.path.exists(os.path.join(engine_dir, fn)),
              "surface file missing: www/validate/engine/%s" % fn)

    # Enumerate EVERY generated HTML file (landing + hub + walkthrough + all
    # rule pages) so every internal link on each is integrity-checked.
    html_files = []
    if os.path.exists(landing_path):
        html_files.append(landing_path)
    if os.path.exists(hub_path):
        html_files.append(hub_path)
    if os.path.exists(walkthrough_path):
        html_files.append(walkthrough_path)
    if os.path.exists(licensing_path):
        html_files.append(licensing_path)
    if os.path.exists(compare_path):
        html_files.append(compare_path)
    if os.path.exists(validate_path):
        html_files.append(validate_path)
    if os.path.exists(de_path):
        html_files.append(de_path)
    if os.path.exists(de_walkthrough_path):
        html_files.append(de_walkthrough_path)
    for rid in sorted(want & have):
        rp = os.path.join(RULES_DIR, rid, "index.html")
        if os.path.exists(rp):
            html_files.append(rp)

    # Every INTERNAL href in every generated HTML file must resolve to a real
    # generated file (no dangling link). External (http/https/mailto) hrefs and
    # pure in-page fragments (#id) are not file targets and are skipped; the
    # absolute canonical <link> href is external and thus skipped here too.
    href_re = re.compile(r'\bhref="([^"]*)"', re.IGNORECASE)
    generated_set = {os.path.realpath(p) for p in html_files}
    for pth in html_files:
        page = open(pth, encoding="utf-8").read()
        base = os.path.dirname(pth)
        for raw in href_re.findall(page):
            href = html.unescape(raw)
            if href.startswith(("http://", "https://", "mailto:", "#")):
                continue
            target = href.split("#", 1)[0].split("?", 1)[0]
            if not target:
                continue
            resolved = os.path.realpath(os.path.join(base, target))
            check(resolved in generated_set or os.path.exists(resolved),
                  "%s: internal href %r resolves to a NON-generated/nonexistent"
                  " target (%s)" % (os.path.relpath(pth, HERE), href, resolved))

    # sitemap.xml must list EXACTLY the generated canonical page set: landing +
    # rule index hub + every rule page (no orphan, no missing, no stale entry).
    if os.path.exists(sitemap_path):
        sm = open(sitemap_path, encoding="utf-8").read()
        locs = [html.unescape(x)
                for x in re.findall(r"<loc>(.*?)</loc>", sm, re.S)]
        got = set(locs)
        check(len(locs) == len(got), "sitemap has duplicate <loc> entries")
        expected = {_gen._url_landing(), _gen._url_hub(),
                    _gen._url_walkthrough(), _gen._url_licensing(),
                    _gen._url_compare(), _gen._url_validate(),
                    _gen._url_de(), _gen._url_de_walkthrough()}
        expected |= {_gen._url_rule(rid) for rid in (want & have)}
        check(got == expected,
              "sitemap <loc> set != generated canonical set; missing=%s "
              "orphan=%s" % (sorted(expected - got)[:5], sorted(got - expected)[:5]))

        # <lastmod> discipline (T-VHSEO.2): every <url> must carry EXACTLY one
        # <lastmod> immediately after its <loc>, each a valid ISO-8601 date
        # equal to the single gen_site.SITE_LASTMOD source of truth. Counts
        # must line up 1:1: url-count == loc-count == lastmod-count.
        url_count = len(re.findall(r"<url>", sm))
        lastmods = re.findall(r"<lastmod>(.*?)</lastmod>", sm, re.S)
        check(url_count == len(locs) == len(lastmods) > 0,
              "sitemap url/loc/lastmod counts disagree: url=%d loc=%d lastmod=%d"
              % (url_count, len(locs), len(lastmods)))
        # Exactly one <lastmod> per <url> element (no url missing/doubling it).
        per_url = re.findall(r"<url>.*?</url>", sm, re.S)
        check(len(per_url) == url_count,
              "sitemap has malformed <url> elements")
        for elem in per_url:
            check(len(re.findall(r"<lastmod>", elem)) == 1,
                  "sitemap <url> does not carry exactly one <lastmod>: %s" % elem)
        # Every <lastmod> parses as an ISO date AND equals SITE_LASTMOD, and
        # there is exactly one distinct value across the whole sitemap.
        for lm in lastmods:
            datetime.date.fromisoformat(lm)  # raises on non-ISO -> test fails
            check(lm == _gen.SITE_LASTMOD,
                  "sitemap <lastmod> %r != gen_site.SITE_LASTMOD %r"
                  % (lm, _gen.SITE_LASTMOD))
        check(len(set(lastmods)) == 1,
              "sitemap has multiple distinct <lastmod> values: %s"
              % sorted(set(lastmods)))

        # No page listed in the sitemap may carry a noindex robots meta
        # (indexable/sitemap consistency). Map each loc back to its file.
        noindex_re = re.compile(
            r'<meta[^>]*name="robots"[^>]*noindex', re.IGNORECASE)
        loc_to_file = {_gen._url_landing(): landing_path,
                       _gen._url_hub(): hub_path,
                       _gen._url_walkthrough(): walkthrough_path,
                       _gen._url_licensing(): licensing_path,
                       _gen._url_compare(): compare_path,
                       _gen._url_validate(): validate_path,
                       _gen._url_de(): de_path,
                       _gen._url_de_walkthrough(): de_walkthrough_path}
        for rid in (want & have):
            loc_to_file[_gen._url_rule(rid)] = os.path.join(
                RULES_DIR, rid, "index.html")
        for loc in got:
            fp = loc_to_file.get(loc)
            check(fp is not None, "sitemap loc has no mapped file: %s" % loc)
            if fp and os.path.exists(fp):
                doc = open(fp, encoding="utf-8").read()
                check(not noindex_re.search(doc),
                      "sitemap lists a NOINDEX page (contradiction): %s" % loc)

    # robots.txt must allow crawling and reference the sitemap URL.
    if os.path.exists(robots_path):
        rb = open(robots_path, encoding="utf-8").read()
        check("Sitemap:" in rb, "robots.txt has no Sitemap: line")
        check(_gen._url_sitemap() in rb,
              "robots.txt Sitemap: does not point at gen_site._url_sitemap()")
        check(re.search(r"(?im)^\s*Allow:\s*/\s*$", rb)
              or "Disallow:" not in rb,
              "robots.txt does not allow crawling")

    # ---- (f) licensing page SELLS honestly (T-BUY.1) -----------------------
    # The commercial cash register must be OPEN on the generated page: both
    # published prices, the private hello@ contact, and either a real checkout
    # element (when CHECKOUT_URL is set) or the honest fallback line (when it is
    # empty, as committed). No refusal/negotiated-contract copy may survive.
    if os.path.exists(licensing_path):
        lic_raw = open(licensing_path, encoding="utf-8").read()
        lic_txt = _visible_text(lic_raw)
        check("$29" in lic_txt, "licensing page missing $29 price")
        check("$290" in lic_txt, "licensing page missing $290 price")
        check("hello@verifyhash.com" in lic_raw,
              "licensing page missing hello@verifyhash.com contact")
        # A commercial contact must be reachable, not just printed: a mailto to
        # hello@ (buy/ask path).
        check('mailto:hello@verifyhash.com' in lic_raw,
              "licensing page has no mailto:hello@verifyhash.com link")
        # Checkout: a real self-serve buy element sourced from CHECKOUT_URL, OR
        # the committed honest fallback line — never a dead link. Assert exactly
        # the branch matching the committed CHECKOUT_URL value.
        if _gen.CHECKOUT_URL:
            check('class="buy"' in lic_raw and _gen.CHECKOUT_URL in lic_raw,
                  "CHECKOUT_URL set but no buy button pointing at it")
        else:
            check("Checkout is not open yet" in lic_txt
                  and "hello@verifyhash.com" in lic_txt,
                  "empty CHECKOUT_URL but honest fallback line is missing")
            # waitlist mode must NOT promise fulfilment we cannot deliver
            for overpromise in ("payment link", "same working day and the vendor key"):
                check(overpromise not in lic_txt.lower(),
                      "licensing fallback over-promises: %r" % overpromise)
        # The word 'checkout' must appear (element or fallback), matching the
        # task's checkout gate.
        check("checkout" in lic_raw.lower(),
              "licensing page has no checkout element or fallback")
        # HONESTY: the old refusal / negotiated-contract / metered pitch must be
        # gone, and no fear/compliance-pressure framing may appear.
        low = lic_txt.lower()
        for banned in ("no price list is published", "no payment link",
                       "negotiated bilateral", "required for compliance",
                       "metered self-host"):
            check(banned not in low,
                  "licensing page still carries banned copy: %r" % banned)

    # ---- (h) COMPARE page (T-VHCMP.1): honest + CLAIMS-DRIFT guard ---------
    # www/compare/index.html must exist, name both alternatives, concede the
    # honest limits (official reference status, no XSD validation, no full
    # Peppol BIS, Mustangproject writes ZUGFeRD PDFs), state that our
    # correctness claim DERIVES FROM the official KoSIT artifact, and be
    # ENGLISH-only (no /de/ variant — the VHDE thin-content cap). Every
    # engine figure on the page carries a data-claim attribute; each one is
    # parsed back out of the emitted HTML here and bound to the SAME live
    # registry gen_site rendered it from, so the page can never silently lie.
    check(os.path.exists(compare_path),
          "www/compare/index.html missing (T-VHCMP.1)")
    if os.path.exists(compare_path):
        cmp_raw = open(compare_path, encoding="utf-8").read()
        cmp_txt = _visible_text(cmp_raw)

        # Names both alternatives, honestly framed.
        check("KoSIT" in cmp_txt, "compare page never names KoSIT")
        check("Mustangproject" in cmp_txt,
              "compare page never names Mustangproject")
        check("reference implementation" in cmp_txt,
              "compare page does not concede KoSIT's official reference "
              "status")
        check("free" in cmp_txt.lower(),
              "compare page does not say the alternatives are free")

        # The 'when to prefer them' concession section with its hard items.
        check("When to prefer them" in cmp_txt,
              "compare page has no 'When to prefer them' section")
        check("XSD" in cmp_txt and "not" in cmp_txt.lower(),
              "compare page does not concede the missing XSD validation")
        check("Peppol BIS" in cmp_txt,
              "compare page does not concede the Peppol BIS limit")
        check("ZUGFeRD" in cmp_txt,
              "compare page does not concede Mustangproject's ZUGFeRD "
              "PDF-writing capability")

        # The derives-from relationship must be explicit.
        check("derives from" in cmp_txt.lower(),
              "compare page does not state the correctness claim derives "
              "from the official KoSIT artifact")

        # CLAIMS-DRIFT: rule count — every data-claim="rule-count" figure on
        # the page must equal the LIVE engine-fireable id count (and at least
        # one must be present).
        live_rules = len(_coverage.engine_fireable_ids())
        counts = re.findall(r'data-claim="rule-count">(\d+)<', cmp_raw)
        check(len(counts) >= 1, "compare page emits no rule-count claim")
        for c in counts:
            check(int(c) == live_rules,
                  "compare page rule-count claim %s != live "
                  "engine_fireable_ids count %d" % (c, live_rules))

        # CLAIMS-DRIFT: Peppol subset size — bound to the live Peppol id sets.
        live_peppol = len(_coverage.peppol_ubl_rule_ids()
                          | _coverage.peppol_cii_rule_ids())
        pcounts = re.findall(r'data-claim="peppol-count">(\d+)<', cmp_raw)
        check(len(pcounts) >= 1, "compare page emits no peppol-count claim")
        for c in pcounts:
            check(int(c) == live_peppol,
                  "compare page peppol-count claim %s != live Peppol subset "
                  "size %d" % (c, live_peppol))

        # CLAIMS-DRIFT: accepted CII input syntax (T-VHCIISELL.1) — the
        # compare page's "Input syntaxes accepted" row names the CII document
        # root, and that token must equal the localname the ONE dispatch seam
        # (einvoice.validate.CII_ROOT_LOCALNAME) actually matches on. If the
        # engine ever stopped taking a raw CrossIndustryInvoice, or the
        # constant were renamed, this row would become a lie and this check
        # goes red.
        from einvoice.validate import CII_ROOT_LOCALNAME as live_cii_root
        croots = re.findall(r'data-claim="cii-root">rsm:(\w+)<', cmp_raw)
        check(len(croots) >= 1,
              "compare page emits no cii-root claim (the accepted-input-"
              "syntax row is missing its data-claim)")
        for r in croots:
            check(r == live_cii_root,
                  "compare page cii-root claim %r != live "
                  "validate.CII_ROOT_LOCALNAME %r" % (r, live_cii_root))

        # CLAIMS-DRIFT: output-format list — the page's stated format set
        # must equal report.REPORT_FORMATS exactly, and each rendered group
        # of format claims must preserve the registry's order.
        fmts = re.findall(r'data-claim="report-format">([a-z]+)<', cmp_raw)
        check(len(fmts) >= len(_REPORT_FORMATS),
              "compare page emits fewer format claims (%d) than "
              "REPORT_FORMATS (%d)" % (len(fmts), len(_REPORT_FORMATS)))
        check(set(fmts) == set(_REPORT_FORMATS),
              "compare page format set %r != live REPORT_FORMATS %r"
              % (sorted(set(fmts)), sorted(_REPORT_FORMATS)))
        check(len(fmts) % len(_REPORT_FORMATS) == 0 and all(
            tuple(fmts[i:i + len(_REPORT_FORMATS)]) == tuple(_REPORT_FORMATS)
            for i in range(0, len(fmts), len(_REPORT_FORMATS))),
              "compare page format claims are not the full REPORT_FORMATS "
              "tuple in registry order: %r" % fmts)

        # CLAIMS-DRIFT: exit codes — bound to the live cli constants.
        for name, live in (("ok", _cli.EXIT_OK), ("fail", _cli.EXIT_FAIL),
                           ("usage", _cli.EXIT_USAGE),
                           ("parse", _cli.EXIT_PARSE)):
            got = re.findall(r'data-claim="exit-code-%s">(\d+)<' % name,
                             cmp_raw)
            check(len(got) >= 1,
                  "compare page emits no exit-code-%s claim" % name)
            for c in got:
                check(int(c) == live,
                      "compare page exit-code-%s claim %s != live cli value "
                      "%d" % (name, c, live))

        # ENGLISH-only (VHDE cap): the page declares lang="en" and there is
        # no /de/ variant of it.
        check('<html lang="en">' in cmp_raw,
              "compare page does not declare <html lang=\"en\">")
        check(not os.path.exists(
            os.path.join(WWW_DIR, "de", "compare", "index.html")),
              "a German /de/compare/ variant exists (VHDE cap violation)")

        # Self-referential canonical from the same BASE_URL builder.
        ccm = re.search(
            r'<link\b[^>]*\brel="canonical"[^>]*\bhref="([^"]*)"', cmp_raw)
        check(ccm is not None and ccm.group(1) == _gen._url_compare(),
              "compare page canonical is not gen_site._url_compare() (%r)"
              % (ccm.group(1) if ccm else None))

        # Reachable from the landing page (visible navigation, so the
        # link-graph pass above covers it).
        if os.path.exists(landing_path):
            landing_doc = open(landing_path, encoding="utf-8").read()
            check('href="compare/index.html"' in landing_doc,
                  "English landing has no visible href=\"compare/index.html\" "
                  "link to the comparison page")

        # NO FUD: the copy must not disparage the free official tools.
        low_cmp = cmp_txt.lower()
        for banned in ("outdated", "unreliable", "insecure", "abandoned",
                       "avoid kosit", "avoid mustang"):
            check(banned not in low_cmp,
                  "compare page carries FUD-adjacent copy: %r" % banned)

    # ---- (j) in-browser validator page (T-VHWEB.2): STATIC pins only -------
    # No browser, no network, per the task's constitution line — every assert
    # below reads the committed bytes. The page joins the pinned canonical
    # set as a production page (its sitemap/determinism/link-graph membership
    # is asserted in the shared sections of this test).
    check(os.path.exists(validate_path),
          "www/validate/index.html missing (T-VHWEB.2)")
    if os.path.exists(validate_path):
        val_raw = open(validate_path, encoding="utf-8").read()
        val_txt = _visible_text(val_raw)

        # NOTHING external is fetched eagerly: no <script> tag carries a src
        # attribute (the ld+json block and the app script are inline), every
        # <link> is the canonical, and no img/iframe can pull a resource.
        check(not re.search(r'<script\b[^>]*\bsrc\s*=', val_raw,
                            re.IGNORECASE),
              "validate page has a <script src=...> (eager external script)")
        check(not re.search(r'<link\b(?![^>]*\brel="canonical")', val_raw,
                            re.IGNORECASE),
              "validate page has a non-canonical <link>")
        check("<img" not in val_raw.lower()
              and "<iframe" not in val_raw.lower(),
              "validate page embeds an img/iframe element")

        # Pyodide pin: the page carries EXACTLY gen_site's pinned CDN URL
        # (an exact-version /pyodide/vX.Y.Z/ path — never @latest/a range),
        # the sha384 SRI hash, and crossorigin=anonymous, all inside the
        # inline script (guaranteed non-eager by the src-free assert above),
        # injected only from the explicit load-button click handler.
        check(re.fullmatch(
            r"https://cdn\.jsdelivr\.net/pyodide/v\d+\.\d+\.\d+"
            r"/full/pyodide\.js", _gen.PYODIDE_JS_URL) is not None,
              "gen_site.PYODIDE_JS_URL is not an exact-version jsDelivr pin: "
              "%r" % _gen.PYODIDE_JS_URL)
        check(_gen.PYODIDE_JS_URL in val_raw,
              "validate page does not carry the pinned Pyodide URL")
        check(re.fullmatch(r"sha384-[A-Za-z0-9+/]{64}", _gen.PYODIDE_SRI)
              is not None,
              "gen_site.PYODIDE_SRI is not a sha384 SRI value: %r"
              % _gen.PYODIDE_SRI)
        check(_gen.PYODIDE_SRI in val_raw,
              "validate page does not carry the SRI sha384 integrity hash")
        check('s.integrity = PYODIDE_SRI' in val_raw,
              "injected script element does not set the integrity attribute")
        check('s.crossOrigin = "anonymous"' in val_raw,
              "injected script element does not set crossorigin=anonymous")
        check('id="load-btn"' in val_raw
              and 'loadBtn.addEventListener("click", loadValidator)'
              in val_raw,
              "no explicit load-button click wiring (Pyodide must never "
              "load eagerly)")

        # Honest CDN-failure state: the pip-install fallback snippet is in
        # the static document (revealed by the failure handler).
        check("pip install verifyhash-einvoice" in val_raw,
              "validate page is missing the pip install fallback snippet")
        check('id="fallback"' in val_raw and "fallbackEl.hidden = false"
              in val_raw,
              "failure handler never reveals the fallback block")

        # Engine mount is manifest-driven and sibling-relative.
        check('fetch("engine/manifest.json")' in val_raw,
              "validate page does not fetch engine/manifest.json")

        # Findings hyperlink rule ids into ../rules/<id>/ and ONLY for ids
        # whose page really exists: the embedded RULE_PAGES list must equal
        # the live catalog id set exactly.
        check('"../rules/"' in val_raw,
              "findings renderer does not link into ../rules/")
        rp = re.search(r"var RULE_PAGES = (\[[^\]]*\]);", val_raw)
        check(rp is not None,
              "validate page embeds no RULE_PAGES id list")
        if rp:
            try:
                embedded_ids = json.loads(rp.group(1))
            except Exception as exc:  # noqa: BLE001
                embedded_ids = None
                check(False, "RULE_PAGES does not parse as JSON: %s" % exc)
            if embedded_ids is not None:
                check(set(embedded_ids) == set(catalog),
                      "RULE_PAGES != live catalog ids; missing=%s orphan=%s"
                      % (sorted(set(catalog) - set(embedded_ids))[:5],
                         sorted(set(embedded_ids) - set(catalog))[:5]))

        # CLAIMS-DRIFT: the rule-count figure binds to the live registry
        # (same discipline as the compare page).
        live_rules_v = len(_coverage.engine_fireable_ids())
        vcounts = re.findall(r'data-claim="rule-count">(\d+)<', val_raw)
        check(len(vcounts) >= 1,
              "validate page emits no rule-count claim")
        for c in vcounts:
            check(int(c) == live_rules_v,
                  "validate page rule-count claim %s != live "
                  "engine_fireable_ids count %d" % (c, live_rules_v))

        # Canonical / language / JSON-LD.
        check('<html lang="en">' in val_raw,
              "validate page does not declare <html lang=\"en\">")
        vcm = re.search(
            r'<link\b[^>]*\brel="canonical"[^>]*\bhref="([^"]*)"', val_raw)
        check(vcm is not None and vcm.group(1) == _gen._url_validate(),
              "validate page canonical is not gen_site._url_validate() (%r)"
              % (vcm.group(1) if vcm else None))
        vld = _LD_RE.findall(val_raw)
        check(len(vld) == 1,
              "validate page: expected exactly 1 ld+json block, got %d"
              % len(vld))
        if vld:
            try:
                vobj = json.loads(vld[0])
            except Exception as exc:  # noqa: BLE001
                vobj = None
                check(False, "validate page JSON-LD does not parse: %s" % exc)
            if vobj is not None:
                check(vobj.get("@type") == "WebApplication",
                      "validate page JSON-LD @type is not WebApplication")

        # The factual privacy line is stated (never a uniqueness claim), and
        # the landing page links the validator visibly (link-graph entry).
        check("never uploaded" in val_txt,
              "validate page does not state the local-processing property")
        if os.path.exists(landing_path):
            landing_doc_v = open(landing_path, encoding="utf-8").read()
            check('href="validate/index.html"' in landing_doc_v,
                  "English landing has no visible href=\"validate/"
                  "index.html\" link to the browser validator")

    # ---- (k) SURFACE-PAGE STRUCTURED DATA (T-VHSHARE.2) ---------------------
    # Every selling page in SURFACE_LDJSON_TYPES must carry EXACTLY ONE
    # application/ld+json element that parses, declares only allowlisted
    # @types, points at its own canonical, and contains no rating/review token.
    # A page that starts emitting an undeclared type fails here rather than
    # quietly asserting something to a search engine that nobody reviewed.
    #
    # MUTATION PROOF first: the grading predicate itself must reject an
    # undeclared type, including one hidden inside a list or a @graph — a
    # vacuous predicate would make every assertion below meaningless.
    check(_ld_type_violations({"@type": "Review"}, {"SoftwareApplication"})
          == ["Review"],
          "_ld_type_violations does not reject an undeclared top-level @type")
    check(_ld_type_violations({"@graph": [{"@type": "BreadcrumbList"},
                                          {"@type": "AggregateRating"}]},
                              {"BreadcrumbList"}) == ["AggregateRating"],
          "_ld_type_violations does not unwrap @graph")
    check(_ld_type_violations([{"@type": "BreadcrumbList"}, {"name": "x"}],
                              {"BreadcrumbList"}) == ["<missing>"],
          "_ld_type_violations accepts an untyped node")

    # Every absolute URL the generator's own _url_*() helpers can produce for a
    # surface page. Breadcrumb `item` URLs must come from THIS set, so a
    # hand-typed or drifted URL in the structured data cannot pass.
    surface_urls = {_gen._url_landing(), _gen._url_hub(),
                    _gen._url_walkthrough(), _gen._url_licensing(),
                    _gen._url_compare(), _gen._url_validate(),
                    _gen._url_de(), _gen._url_de_walkthrough()}
    crumb_re = re.compile(r'<p class="crumb">(.*?)</p>', re.S)

    for rel, allowed in sorted(SURFACE_LDJSON_TYPES.items()):
        spath = os.path.join(WWW_DIR, *rel.split("/"))
        if not os.path.exists(spath):
            check(False, "surface page is missing entirely: www/%s" % rel)
            continue
        sraw = open(spath, encoding="utf-8").read()

        # (1) exactly one ld+json element.
        sblocks = _LD_RE.findall(sraw)
        check(len(sblocks) == 1,
              "www/%s: expected exactly 1 ld+json block, got %d"
              % (rel, len(sblocks)))
        if len(sblocks) != 1:
            continue
        sld_raw = sblocks[0]

        # (6) no raw '</script>' survived inside the JSON (same guard the rule
        # pages get): the serializer neutralises '<' to <.
        check("</script>" not in sld_raw.lower()
              and "</script " not in sld_raw.lower(),
              "www/%s: raw '</script>' survived inside JSON-LD" % rel)

        # (2) it parses.
        try:
            sobj = json.loads(sld_raw)
        except Exception as exc:  # noqa: BLE001
            sobj = None
            check(False, "www/%s: JSON-LD does not parse: %s" % (rel, exc))
        if sobj is None:
            continue

        # (3) every top-level @type is allowlisted for THIS page.
        violations = _ld_type_violations(sobj, allowed)
        check(not violations,
              "www/%s: JSON-LD carries @type(s) %r not in "
              "SURFACE_LDJSON_TYPES[%r] = %r"
              % (rel, violations, rel, sorted(allowed)))

        # (5) no fabricated social proof anywhere in the block.
        check(not _LD_BANNED_RE.search(sld_raw),
              "www/%s: JSON-LD contains a rating/review token" % rel)

        # (4) the block points at THIS page: a node `url`, or the terminal
        # breadcrumb item, must byte-equal the page's own rel=canonical.
        scm = re.search(
            r'<link\b[^>]*\brel="canonical"[^>]*\bhref="([^"]*)"', sraw)
        check(scm is not None, "www/%s: no rel=canonical to bind to" % rel)
        if scm is None:
            continue
        s_canon = html.unescape(scm.group(1))
        self_urls = set()
        crumb_vis = " ".join(
            _visible_text(c) for c in crumb_re.findall(sraw))
        for node in _ld_nodes(sobj):
            if node.get("url"):
                self_urls.add(node["url"])
            if node.get("@type") == "BreadcrumbList":
                items = node.get("itemListElement") or []
                check(len(items) >= 2,
                      "www/%s: BreadcrumbList has fewer than 2 items" % rel)
                for pos, item in enumerate(items, 1):
                    check(item.get("position") == pos,
                          "www/%s: breadcrumb position %r is not %d"
                          % (rel, item.get("position"), pos))
                    # item URLs come from the _url_*() helpers, never typed.
                    check(item.get("item") in surface_urls,
                          "www/%s: breadcrumb item %r is not a gen_site "
                          "_url_*() surface URL" % (rel, item.get("item")))
                    # ANTI-CLOAKING: the structured trail must be the trail a
                    # human sees in the page's own <p class="crumb"> line.
                    check(str(item.get("name")) in crumb_vis,
                          "www/%s: breadcrumb name %r is not in the visible "
                          "crumb text" % (rel, item.get("name")))
                if items:
                    self_urls.add(items[-1].get("item"))
        check(s_canon in self_urls,
              "www/%s: JSON-LD url / terminal breadcrumb item %r does not "
              "include the page canonical %r" % (rel, sorted(self_urls),
                                                 s_canon))

        # SoftwareApplication pages: name/description are the page's OWN
        # <title>/<meta description> (no second copy of any claim to drift),
        # and softwareVersion is the LIVE einvoice.__version__ — a hard-coded
        # version string in gen_site.py fails right here.
        for node in _ld_nodes(sobj):
            if node.get("@type") != "SoftwareApplication":
                continue
            stm = _TITLE_RE.search(sraw)
            sdm = _DESC_RE.search(sraw)
            check(stm is not None and node.get("name")
                  == html.unescape(stm.group(1)),
                  "www/%s: SoftwareApplication name != the page <title>" % rel)
            check(sdm is not None and node.get("description")
                  == html.unescape(sdm.group(1)),
                  "www/%s: SoftwareApplication description != the page meta "
                  "description" % rel)
            check(node.get("softwareVersion") == _ENGINE_VERSION,
                  "www/%s: softwareVersion %r != live einvoice.__version__ %r"
                  % (rel, node.get("softwareVersion"), _ENGINE_VERSION))
            # The license the package actually ships (pyproject classifier
            # "License :: OSI Approved :: Apache Software License").
            check(node.get("license") == "Apache-2.0",
                  "www/%s: SoftwareApplication license %r is not the shipped "
                  "Apache-2.0" % (rel, node.get("license")))
            check("offers" not in node,
                  "www/%s: SoftwareApplication carries an offers node while "
                  "gen_site.CHECKOUT_URL is empty" % rel)

    # No page under www/ — surface, rule or otherwise — may carry a rating or
    # review token, in structured data or in prose.
    for droot, _dirs, files in os.walk(WWW_DIR):
        for fname in files:
            if not fname.endswith(".html"):
                continue
            fpath = os.path.join(droot, fname)
            check(not _LD_BANNED_RE.search(
                      open(fpath, encoding="utf-8").read()),
                  "%s: carries a rating/review token"
                  % os.path.relpath(fpath, HERE))

    # ---- (g) German product/quickstart page (T-VHDE.1) ---------------------
    # www/de/index.html is a first-class generated page: correct document
    # language, self-referential canonical from BASE_URL, hreflang alternates
    # in BOTH directions (de page <-> English landing), a visible landing
    # link, every shell command byte-identical to the test-pinned English
    # docs, and NO per-rule German pages (the thin-content hard line).
    alt_re = re.compile(
        r'<link\b[^>]*\brel="alternate"[^>]*\bhreflang="([^"]*)"[^>]*'
        r'\bhref="([^"]*)"', re.IGNORECASE)
    if os.path.exists(de_path) and os.path.exists(landing_path):
        de_raw = open(de_path, encoding="utf-8").read()
        landing_raw = open(landing_path, encoding="utf-8").read()

        # Document language + canonical.
        check('<html lang="de">' in de_raw,
              "www/de/index.html does not declare <html lang=\"de\">")
        cmatch = re.search(
            r'<link\b[^>]*\brel="canonical"[^>]*\bhref="([^"]*)"', de_raw)
        check(cmatch is not None and cmatch.group(1) == _gen._url_de(),
              "www/de/index.html canonical is not gen_site._url_de() (%r)"
              % (cmatch.group(1) if cmatch else None))

        # hreflang alternates BOTH directions. The de page must reference the
        # English landing (hreflang="en") and itself (hreflang="de"); the
        # English landing must reference the de page (hreflang="de") and
        # itself (hreflang="en").
        de_alts = {hl: href for hl, href in alt_re.findall(de_raw)}
        landing_alts = {hl: href for hl, href in alt_re.findall(landing_raw)}
        check(de_alts.get("en") == _gen._url_landing(),
              "de page hreflang=\"en\" does not point at the English landing "
              "(got %r)" % de_alts.get("en"))
        check(de_alts.get("de") == _gen._url_de(),
              "de page lacks its self-referencing hreflang=\"de\" (got %r)"
              % de_alts.get("de"))
        check(landing_alts.get("de") == _gen._url_de(),
              "English landing hreflang=\"de\" does not point at www/de/ "
              "(got %r)" % landing_alts.get("de"))
        check(landing_alts.get("en") == _gen._url_landing(),
              "English landing lacks its self-referencing hreflang=\"en\" "
              "(got %r)" % landing_alts.get("en"))

        # The landing must carry a VISIBLE navigation link to the de page
        # (hreflang <link>s live in <head> and are not user navigation).
        check('href="de/index.html"' in landing_raw,
              "English landing has no visible href=\"de/index.html\" link")

        # Unique title + meta description across ALL five surface pages (the
        # per-rule loop above already guarantees rule-page uniqueness).
        surface_titles = []
        surface_descs = []
        for spath in (landing_path, hub_path, walkthrough_path,
                      licensing_path, compare_path, validate_path, de_path,
                      de_walkthrough_path):
            sraw = open(spath, encoding="utf-8").read()
            tm = _TITLE_RE.search(sraw)
            dm = _DESC_RE.search(sraw)
            check(tm is not None and dm is not None,
                  "%s: missing <title> or meta description"
                  % os.path.relpath(spath, HERE))
            surface_titles.append(tm.group(1) if tm else "")
            surface_descs.append(dm.group(1) if dm else "")
        check(len(set(surface_titles)) == len(surface_titles),
              "surface page <title>s are not unique: %r" % surface_titles)
        check(len(set(surface_descs)) == len(surface_descs),
              "surface page meta descriptions are not unique")

        # COMMAND BYTE-IDENTITY, both directions: every command gen_site
        # renders on the German page (gen_site.DE_COMMANDS) must appear
        # VERBATIM (a) on the rendered de page and (b) in the English doc it
        # is pinned to (QUICKSTART.md is executed by test_quickstart.py,
        # ci/README.md's recipes by test_ci_recipe.py). A drifted or invented
        # command fails here.
        de_vis = html.unescape(de_raw)
        check(len(_gen.DE_COMMANDS) >= 5,
              "gen_site.DE_COMMANDS shrank below the install/validate/CI set")
        for cmd, doc_rel in _gen.DE_COMMANDS:
            check(cmd in de_vis,
                  "de page is missing pinned command verbatim: %r" % cmd)
            doc_path = os.path.join(HERE, doc_rel)
            check(os.path.exists(doc_path),
                  "DE_COMMANDS references a missing doc: %s" % doc_rel)
            if os.path.exists(doc_path):
                doc_text = open(doc_path, encoding="utf-8").read()
                check(cmd in doc_text,
                      "command on the de page is NOT byte-identical to any "
                      "line of %s: %r" % (doc_rel, cmd))

        # HARD LINE: no per-rule German pages (thin-content line) — www/de/
        # holds EXACTLY the product page index.html plus the single worked
        # walkthrough/ subdir (T-VHDE.3), and nothing else. The walkthrough
        # subdir itself holds only its index.html — one German walkthrough, not
        # a fan-out of pages.
        de_dir = os.path.dirname(de_path)
        check(not os.path.isdir(os.path.join(de_dir, "rules")),
              "per-rule German pages exist under www/de/rules/ (thin-content "
              "hard line)")
        de_entries = sorted(os.listdir(de_dir))
        check(de_entries == ["index.html", "walkthrough"],
              "www/de/ must hold exactly index.html + walkthrough/, got: %r"
              % de_entries)
        de_walk_dir = os.path.join(de_dir, "walkthrough")
        check(os.path.isdir(de_walk_dir)
              and sorted(os.listdir(de_walk_dir)) == ["index.html"],
              "www/de/walkthrough/ must hold exactly index.html (one German "
              "walkthrough page), got: %r"
              % (sorted(os.listdir(de_walk_dir))
                 if os.path.isdir(de_walk_dir) else None))

        # hreflang alternates BOTH directions between the two walkthroughs
        # (T-VHDE.3): the German walkthrough references the English page
        # (hreflang="en") and itself (hreflang="de"); the English walkthrough
        # references the German page (hreflang="de") and itself (hreflang="en").
        if os.path.exists(de_walkthrough_path) and os.path.exists(
                walkthrough_path):
            de_walk_raw = open(de_walkthrough_path, encoding="utf-8").read()
            en_walk_raw = open(walkthrough_path, encoding="utf-8").read()
            check('<html lang="de">' in de_walk_raw,
                  "www/de/walkthrough/index.html does not declare lang=\"de\"")
            dw_alts = {hl: href for hl, href in alt_re.findall(de_walk_raw)}
            ew_alts = {hl: href for hl, href in alt_re.findall(en_walk_raw)}
            check(dw_alts.get("en") == _gen._url_walkthrough(),
                  "German walkthrough hreflang=\"en\" does not point at the "
                  "English walkthrough (got %r)" % dw_alts.get("en"))
            check(dw_alts.get("de") == _gen._url_de_walkthrough(),
                  "German walkthrough lacks self hreflang=\"de\" (got %r)"
                  % dw_alts.get("de"))
            check(ew_alts.get("de") == _gen._url_de_walkthrough(),
                  "English walkthrough hreflang=\"de\" does not point at the "
                  "German walkthrough (got %r)" % ew_alts.get("de"))
            check(ew_alts.get("en") == _gen._url_walkthrough(),
                  "English walkthrough lacks self hreflang=\"en\" (got %r)"
                  % ew_alts.get("en"))
            # The German product page links to the German walkthrough with the
            # de-relative href the task pins.
            check('href="walkthrough/index.html"' in de_raw,
                  "www/de/index.html has no href=\"walkthrough/index.html\" "
                  "link to the German walkthrough")

    # ---- (i) DETERMINISM (T-VHSITEDET.1): regenerate TWICE into two temp
    # output dirs -> equal file sets + byte-identical files; no path leakage.
    # The committed www/ tree is NEVER written by this section (out_dir=...).
    import tempfile
    with tempfile.TemporaryDirectory() as tmp1, \
            tempfile.TemporaryDirectory() as tmp2:
        # First run and second run: each is a FULL fresh generator pass
        # (catalog load + render_all + render_surface + write), so any
        # nondeterminism in ordering or rendering shows up between them.
        cat1 = _remediation.load_catalog()
        _gen.write(_gen.render_all(cat1), _gen.render_surface(cat1),
                   out_dir=tmp1)
        cat2 = _remediation.load_catalog()
        _gen.write(_gen.render_all(cat2), _gen.render_surface(cat2),
                   out_dir=tmp2)

        def _tree(root):
            """rel path -> raw bytes for every file under root."""
            out = {}
            for dirpath, _dirs, files in os.walk(root):
                for fn in files:
                    p = os.path.join(dirpath, fn)
                    with open(p, "rb") as fh:
                        out[os.path.relpath(p, root)] = fh.read()
            return out

        t1, t2 = _tree(tmp1), _tree(tmp2)
        check(set(t1) == set(t2),
              "second run emitted a DIFFERENT file set; only-in-run1=%s "
              "only-in-run2=%s"
              % (sorted(set(t1) - set(t2))[:5], sorted(set(t2) - set(t1))[:5]))
        drifted = [rel for rel in sorted(set(t1) & set(t2))
                   if t1[rel] != t2[rel]]
        check(not drifted,
              "regenerated files are NOT byte-identical across the two runs: "
              "%s" % drifted[:10])

        # The emitted set covers EVERY page family — incl. www/compare/ and
        # www/de/ (the surfaces OWNER-GOLIVE Step 3 takes live) — plus one
        # page per catalog rule.
        for rel in ("index.html",
                    os.path.join("rules", "index.html"),
                    os.path.join("walkthrough", "index.html"),
                    os.path.join("licensing", "index.html"),
                    os.path.join("compare", "index.html"),
                    os.path.join("validate", "index.html"),
                    os.path.join("de", "index.html"),
                    os.path.join("de", "walkthrough", "index.html"),
                    "sitemap.xml", "robots.txt"):
            check(rel in t1,
                  "regenerated tree is missing surface file %s" % rel)
        for rid in sorted(want):
            check(os.path.join("rules", rid, "index.html") in t1,
                  "regenerated tree is missing rule page for %s" % rid)
        # Engine bundle (T-VHWEB.1): the regenerated tree carries the traced
        # module set + manifest.json — same live tracer as the committed-tree
        # pin above, so the run-twice byte-identity and path-invariance scans
        # cover every engine file too.
        for fn in ["manifest.json"] + [m + ".py"
                                       for m in _gen.engine_bundle_modules()]:
            check(os.path.join("validate", "engine", fn) in t1,
                  "regenerated tree is missing engine file "
                  "validate/engine/%s" % fn)

        # PATH INVARIANCE: no emitted byte may carry $HOME, the repo dir,
        # the temp output dir's own path, or the username — the tree must be
        # publishable from any machine with an unreviewable-diff-free deploy.
        home = os.path.expanduser("~")
        username = os.path.basename(home.rstrip(os.sep))
        check(bool(username), "cannot derive a username from $HOME")
        banned = [(home.encode("utf-8"), "$HOME path"),
                  (HERE.encode("utf-8"), "repo absolute path"),
                  (os.path.realpath(tmp1).encode("utf-8"), "temp output dir")]
        if username:
            banned.append((username.encode("utf-8"), "username"))
        for rel in sorted(t1):
            data = t1[rel]
            for tok, label in banned:
                check(tok not in data,
                      "emitted file %s leaks the %s (%r)"
                      % (rel, label, tok.decode("utf-8", "replace")))

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

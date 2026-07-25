#!/usr/bin/env python3
"""test_share_metadata.py — structural guard over the link-preview surface
(``einvoice/www/``).

WHY THIS EXISTS. Every channel we can announce this project on — LinkedIn,
XING, Slack, Reddit, Mastodon, Discord, iMessage, X — renders a shared URL as a
CARD built from Open Graph / Twitter ``<meta>`` tags, and falls back to bare
grey text when they are missing. The announce is one-shot: a URL that unfurls
badly the first time does not get a second first impression. The tags landed on
the 8 hand-built surface pages in T-VHSHARE.5 with only grep-level verification,
and the indexable rule pages — 24 of the 32 sitemap URLs at the time, 16 of 24
since T-VHCRAWL.3 collapsed the near-duplicate clusters — still emitted none
until T-VHSHARE.3. This guard makes the share surface COMPLETE and impossible
to break silently.

WHAT IT ASSERTS, over every ``*.html`` file under ``www/``:

  (1) every page listed in ``www/sitemap.xml`` carries the full tag set —
      og:type, og:site_name, og:title, og:description, og:url, og:locale,
      twitter:card, twitter:title, twitter:description — each with a
      non-empty ``content``;
  (2) og:url byte-equals that page's ``<link rel="canonical">`` href;
  (3) og:title / og:description are non-empty and are not the bare SITE_NAME,
      and are pairwise DISTINCT across the eight non-rule-detail pages (one
      identical card on every page is the near-duplicate defect T-VHCRAWL.1
      fixed one layer up, re-appearing in the share layer);
  (4) og:locale agrees with the page's ``<html lang>`` through
      ``gen_site._OG_LOCALE`` — the mapping is IMPORTED, never re-typed here,
      so the guard cannot drift from the generator;
  (5) every ``application/ld+json`` block parses and its top-level ``@type`` is
      in an explicit allowlist; no page carries more than one block;
  (6) any og:image / twitter:image must resolve to a file that EXISTS under
      ``www/``. No image exists today; the check is live, not skipped, so the
      day one is added a broken path fails here instead of on LinkedIn;
  (7) the pairing invariant: a page is in ``sitemap.xml`` IF AND ONLY IF it
      carries the share block, and no page carrying ``robots ... noindex`` may
      appear in the sitemap.

Every legitimate exception is an explicit, commented allowlist entry below. An
undeclared violation FAILS. Standard library only, no network, no pip; it reads
the committed tree and finishes in well under a second.

    python3 test_share_metadata.py
"""

from __future__ import annotations

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WWW_DIR = os.path.join(HERE, "www")
SITEMAP_PATH = os.path.join(WWW_DIR, "sitemap.xml")

sys.path.insert(0, HERE)
import gen_site as _gen  # noqa: E402  (path set above)

# ---------------------------------------------------------------------------
# ALLOWLIST 1 — schema.org top-level @types any page may emit.
#
# Each entry is a type this surface deliberately publishes; an UNLISTED @type
# fails, because a wrong or invented type is a structured-data lie that search
# engines act on.
#   SoftwareApplication — the product pages (landing, licensing, compare, ...)
#                         describe the einvoice CLI as software.
#   BreadcrumbList      — the navigational trail those same pages emit.
#   WebApplication      — www/validate/, the in-browser validator, which really
#                         IS an application the visitor runs.
#   TechArticle         — one per rule reference page: a technical explainer of
#                         a single EN 16931 / XRechnung rule.
_LDJSON_TYPES = ("SoftwareApplication", "BreadcrumbList", "WebApplication",
                 "TechArticle")

# ---------------------------------------------------------------------------
# ALLOWLIST 2 — pages EXEMPT from the pairwise-distinctness check (3) ONLY.
#
# The 16 indexable rule-detail pages share a description PATTERN by design:
# gen_site._description() renders "<ID> (EN 16931 / XRechnung rule): <title>
# Fix: <fix>". The strings are all different (the unique rule id leads every
# one) but they are formulaic, so holding them to the same "no two pages may
# resemble each other" bar as the eight hand-written surface pages would be
# measuring the wrong thing. They remain fully subject to (1), (2), (4), (5),
# (6) and (7), and to the non-empty / not-bare-SITE_NAME part of (3).
#
# This exemption covers the CARD STRINGS only, and it is NOT a licence for the
# pages themselves to resemble each other: since T-VHCRAWL.3 the page BODIES of
# exactly this set are held to gen_site.RULE_PAGE_SIMILARITY_CEILING by
# test_page_uniqueness.py, which is the check that has teeth here.
#
# This list is checked for drift below: it must equal EXACTLY the set of
# rule-detail pages sitemap.xml lists. Retuning
# gen_site.RULE_PAGE_DISTINCTIVENESS_FLOOR or
# gen_site.RULE_PAGE_SIMILARITY_CEILING changes that set and will fail here
# — deliberately, so the exemption is re-granted by a human rather than
# inherited silently.
#
# RE-GRANTED 2026-07-25 (T-VHCRAWL.3): eight ids were REMOVED from this list —
# BR-AE-08, BR-AG-08, BR-CL-10, BR-E-08, BR-IC-08, BR-O-08, BR-S-08, BR-Z-08.
# They were not re-judged as pages; they simply left the sitemap when the new
# similarity ceiling collapsed their three near-duplicate clusters to one
# representative each (BR-AF-08, BR-CL-11, BR-G-08 survived and remain listed
# below). Strictly fewer exemptions = strictly more pages held to check (3).
_DISTINCTNESS_EXEMPT = tuple(
    os.path.join("rules", rid, "index.html") for rid in (
        "BR-51", "BR-CL-01", "BR-CL-06", "BR-CL-07", "BR-CL-11",
        "BR-CO-09", "BR-DEC-25", "BR-AF-08",
        "BR-G-08", "BR-DE-17",
        "BR-DE-18", "BR-DE-28", "BR-DEX-01", "BR-DEX-04", "BR-DEX-15",
        "BR-TMP-3",
    )
)

# The complete card. Open Graph uses property=, Twitter/X uses name=; the tuple
# records which, because a twitter: tag emitted as property= is invisible to X.
_REQUIRED_TAGS = (
    ("property", "og:type"),
    ("property", "og:site_name"),
    ("property", "og:title"),
    ("property", "og:description"),
    ("property", "og:url"),
    ("property", "og:locale"),
    ("name", "twitter:card"),
    ("name", "twitter:title"),
    ("name", "twitter:description"),
)

# Optional image tags — absent today (twitter:card is "summary", the image-less
# card type). Check (6) fires only if one ever appears.
_IMAGE_TAGS = (("property", "og:image"), ("name", "twitter:image"))

_LD_RE = re.compile(
    r'<script\b[^>]*\btype="application/ld\+json"[^>]*>(.*?)</script>',
    re.S | re.IGNORECASE)
_CANON_RE = re.compile(
    r'<link\b[^>]*\brel="canonical"[^>]*\bhref="([^"]*)"', re.IGNORECASE)
_LANG_RE = re.compile(r'<html\b[^>]*\blang="([^"]*)"', re.IGNORECASE)
_ROBOTS_RE = re.compile(
    r'<meta\b[^>]*\bname="robots"[^>]*\bcontent="([^"]*)"', re.IGNORECASE)
_LOC_RE = re.compile(r"<loc>(.*?)</loc>", re.S)


def _meta(page, attr, key):
    """The ``content`` of ``<meta {attr}="{key}" content="...">``, or None.

    Returns the RAW (still HTML-escaped) attribute text, because check (2)
    compares og:url against the canonical href byte for byte and both are
    escaped by the same generator helper.
    """
    m = re.search(
        r'<meta\b[^>]*\b%s="%s"[^>]*\bcontent="([^"]*)"'
        % (attr, re.escape(key)), page, re.IGNORECASE)
    return m.group(1) if m else None


def _iter_pages():
    """(www-relative path, text) for every HTML page, sorted and stable."""
    out = []
    for root, _dirs, files in os.walk(WWW_DIR):
        for name in sorted(files):
            if not name.endswith(".html"):
                continue
            path = os.path.join(root, name)
            with open(path, encoding="utf-8") as fh:
                out.append((os.path.relpath(path, WWW_DIR), fh.read()))
    return sorted(out)


def _url_for(rel):
    """The absolute URL a www-relative page path is published at.

    Mirrors the generator's directory-index layout: ``index.html`` is served as
    its containing directory with a trailing slash, off the single
    ``gen_site.BASE_URL`` constant the sitemap and canonicals also use.
    """
    parts = rel.replace(os.sep, "/").split("/")
    if parts[-1] == "index.html":
        parts = parts[:-1]
    suffix = "/".join(parts)
    base = _gen.BASE_URL.rstrip("/")
    return base + "/" + (suffix + "/" if suffix else "")


def _sitemap_urls():
    with open(SITEMAP_PATH, encoding="utf-8") as fh:
        return set(_LOC_RE.findall(fh.read()))


def _image_exists(content):
    """True iff an og:image/twitter:image content value resolves under www/.

    Accepts the two forms the generator could ever emit: an absolute URL under
    BASE_URL, or a site-root-relative path. Anything else (a third-party CDN,
    say) is not a file we control and fails.
    """
    base = _gen.BASE_URL.rstrip("/") + "/"
    if content.startswith(base):
        rel = content[len(base):]
    elif content.startswith("/"):
        rel = content.lstrip("/")
        # Strip the surface's path prefix if the value is root-relative to the
        # whole domain (e.g. /einvoice/og.png) rather than to www/.
        prefix = base.split("//", 1)[-1].split("/", 1)[-1]
        if prefix and rel.startswith(prefix):
            rel = rel[len(prefix):]
    else:
        return False
    rel = rel.split("?", 1)[0].split("#", 1)[0].lstrip("/")
    return bool(rel) and os.path.exists(os.path.join(WWW_DIR, *rel.split("/")))


def main():
    failures = []

    def check(cond, msg):
        if not cond:
            failures.append(msg)

    if not os.path.isdir(WWW_DIR):
        print("FAIL: www/ not found at %s" % WWW_DIR)
        return 1
    if not os.path.exists(SITEMAP_PATH):
        print("FAIL: www/sitemap.xml not found")
        return 1

    pages = _iter_pages()
    sitemap = _sitemap_urls()
    # Vacuity guards: a walk that found nothing, or a sitemap that parsed to
    # nothing, must never look like a pass.
    check(len(pages) > 100,
          "found only %d HTML pages under www/ — extraction is broken"
          % len(pages))
    check(len(sitemap) > 1,
          "sitemap.xml yielded %d <loc> entries — extraction is broken"
          % len(sitemap))

    listed = {}       # rel -> page text, for pages the sitemap lists
    carded = set()    # rel of pages carrying a share block
    urls_seen = set()

    for rel, page in pages:
        url = _url_for(rel)
        urls_seen.add(url)
        in_sitemap = url in sitemap
        has_card = _meta(page, "property", "og:title") is not None
        if has_card:
            carded.add(rel)
        if in_sitemap:
            listed[rel] = page

        # ---- (7) pairing invariant -------------------------------------
        check(in_sitemap == has_card,
              "%s: sitemap membership (%s) != carries share block (%s) — every "
              "indexable page must advertise a card and no other page may"
              % (rel, in_sitemap, has_card))
        robots = _ROBOTS_RE.search(page)
        if robots and "noindex" in robots.group(1).lower():
            check(not in_sitemap,
                  "%s: page is robots noindex yet listed in sitemap.xml" % rel)

        # ---- (5) structured data ---------------------------------------
        blocks = _LD_RE.findall(page)
        check(len(blocks) <= 1,
              "%s: %d application/ld+json blocks — at most one per page"
              % (rel, len(blocks)))
        if in_sitemap:
            check(len(blocks) == 1,
                  "%s: indexable page carries no application/ld+json block"
                  % rel)
        for raw in blocks:
            try:
                obj = json.loads(raw)
            except Exception as exc:  # noqa: BLE001
                check(False, "%s: ld+json does not parse: %s" % (rel, exc))
                continue
            nodes = obj if isinstance(obj, list) else [obj]
            for node in nodes:
                t = node.get("@type") if isinstance(node, dict) else None
                check(t in _LDJSON_TYPES,
                      "%s: ld+json @type %r is not in the declared allowlist %s"
                      % (rel, t, list(_LDJSON_TYPES)))

        # ---- (6) images, if any ever appear -----------------------------
        for attr, key in _IMAGE_TAGS:
            val = _meta(page, attr, key)
            if val is not None:
                check(_image_exists(val),
                      "%s: %s points at %r, which does not exist under www/"
                      % (rel, key, val))

        if not has_card:
            continue

        # ---- (1) complete tag set, every value non-empty -----------------
        for attr, key in _REQUIRED_TAGS:
            val = _meta(page, attr, key)
            check(val is not None, "%s: missing <meta %s=\"%s\">"
                  % (rel, attr, key))
            check(val is None or val.strip() != "",
                  "%s: %s has an empty content" % (rel, key))

        # ---- (2) og:url byte-equals the canonical href -------------------
        canon = _CANON_RE.search(page)
        check(canon is not None, "%s: no <link rel=\"canonical\">" % rel)
        og_url = _meta(page, "property", "og:url")
        if canon is not None and og_url is not None:
            check(og_url == canon.group(1),
                  "%s: og:url %r != canonical %r"
                  % (rel, og_url, canon.group(1)))
            check(canon.group(1) == url,
                  "%s: canonical %r is not this page's own URL %r"
                  % (rel, canon.group(1), url))

        # ---- (3) title/description are real, not the bare site name ------
        for key in ("og:title", "og:description"):
            val = _meta(page, "property", key) or ""
            check(val.strip() != "", "%s: %s is empty" % (rel, key))
            check(val.strip() != _gen.SITE_NAME,
                  "%s: %s is the bare site name %r — a card must say what THIS "
                  "page is" % (rel, key, _gen.SITE_NAME))
        # twitter:* mirror og:* — a card whose two halves disagree shows one
        # text on X and another on LinkedIn.
        for og_key, tw_key in (("og:title", "twitter:title"),
                               ("og:description", "twitter:description")):
            check(_meta(page, "property", og_key)
                  == _meta(page, "name", tw_key),
                  "%s: %s and %s disagree" % (rel, og_key, tw_key))

        # ---- (4) og:locale agrees with <html lang> -----------------------
        lang = _LANG_RE.search(page)
        check(lang is not None, "%s: <html> has no lang attribute" % rel)
        if lang is not None:
            want = _gen._OG_LOCALE.get(lang.group(1))
            check(want is not None,
                  "%s: <html lang=%r> has no entry in gen_site._OG_LOCALE"
                  % (rel, lang.group(1)))
            if want is not None:
                check(_meta(page, "property", "og:locale") == want,
                      "%s: og:locale %r does not match <html lang=%r> (%r)"
                      % (rel, _meta(page, "property", "og:locale"),
                         lang.group(1), want))

    # ---- every sitemap URL must correspond to a real generated page ------
    for loc in sorted(sitemap - urls_seen):
        check(False, "sitemap lists %s, which no generated page serves" % loc)

    # ---- ALLOWLIST 2 drift check -----------------------------------------
    exempt = set(_DISTINCTNESS_EXEMPT)
    listed_rule_pages = {rel for rel in listed
                         if rel.replace(os.sep, "/").startswith("rules/")
                         and rel.replace(os.sep, "/") != "rules/index.html"}
    check(exempt == listed_rule_pages,
          "the distinctness-exemption allowlist has drifted from the sitemap "
          "(only-in-allowlist=%s only-in-sitemap=%s) — re-grant the exemption "
          "deliberately in _DISTINCTNESS_EXEMPT"
          % (sorted(exempt - listed_rule_pages)[:5],
             sorted(listed_rule_pages - exempt)[:5]))

    # ---- (3) pairwise distinctness across the non-exempt sitemap pages ----
    distinct_set = sorted(set(listed) - exempt)
    check(len(distinct_set) == 8,
          "expected 8 non-rule-detail indexable pages to hold to pairwise "
          "distinctness, found %d (%s)" % (len(distinct_set), distinct_set))
    for key in ("og:title", "og:description"):
        seen = {}
        for rel in distinct_set:
            val = _meta(listed[rel], "property", key)
            if val in seen:
                check(False,
                      "%s: %s is byte-identical to %s's — a card that says the "
                      "same thing on every page is the near-duplicate defect "
                      "one layer up" % (rel, key, seen[val]))
            else:
                seen[val] = rel

    if failures:
        print("SHARE METADATA: FAIL (%d)" % len(failures))
        for msg in failures[:40]:
            print("  !! %s" % msg)
        if len(failures) > 40:
            print("  ... and %d more" % (len(failures) - 40))
        return 1

    print("share metadata OK: %d HTML pages scanned; %d sitemap URLs each "
          "carry the full 9-tag card with og:url == canonical and og:locale == "
          "<html lang>; %d pages exempt from pairwise distinctness (declared); "
          "no page outside the sitemap advertises a card; every ld+json block "
          "parses with an allowlisted @type; no dangling og:image."
          % (len(pages), len(listed), len(exempt)))
    return 0


if __name__ == "__main__":
    sys.exit(main())

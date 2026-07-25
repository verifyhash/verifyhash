#!/usr/bin/env python3
"""Post-deploy live verification for the einvoice reference surface.

READ-ONLY: issues plain HTTP GET requests against the live origin and
compares what is served against the committed ``www/`` tree. It NEVER
edits live content and NEVER touches the deploy pipeline — a mismatch is
reported as a finding (redeploy needed), not fixed here.

COVERAGE IS DERIVED, NOT HAND-KEPT: the byte-compare and 200-spot-check
lists are walked from the committed ``www/`` tree when the module loads —
a pure local directory listing, no network and no file reads (every
``**/index.html`` page family — ``/``, ``/rules/`` + every rule page,
``/walkthrough/``, ``/de/``, ``/de/walkthrough/``, ``/compare/``,
``/licensing/`` — plus ``sitemap.xml`` and ``robots.txt``), so a newly
committed page family is automatically verified live. That is ~290+ URLs
fetched twice (200-check, then byte-compare); expect a run to take a few
minutes on a normal link. ``test_verify_live_paths.py`` pins the derived
lists to the committed tree without any network.

WHAT IS CHECKED (every EXPECTED value is derived from the committed
``www/`` tree at run time — no hard-coded page list, count or URL beyond
the ``--base`` argument, so the checker cannot rot as the tree grows):

  1. every committed page serves HTTP 200;
  2. ``SITEMAP_LOC_PARITY`` — the FULL ``<loc>`` set of the live
     ``sitemap.xml`` equals the FULL ``<loc>`` set of the committed one,
     reported in BOTH directions (missing-live / extra-live) with counts,
     so a "live still lists 305 URLs, committed lists 24" mismatch is
     impossible to overlook. Both sides are normalised the same way
     (whitespace stripped, base prefix removed, trailing slash dropped)
     so a formatting difference is never reported as a content one;
  3. SHARE + STRUCTURED DATA — on the sitemapped surface pages (derived:
     the sitemapped pages that are not per-rule detail pages), the live
     HTML must carry every ``og:``/``twitter:`` tag the committed page
     carries, with the same values (URL-valued tags rebased onto
     ``--base``), exactly one ``application/ld+json`` block that PARSES
     as JSON, and ``og:url`` equal to that page's live
     ``<link rel=canonical>`` href;
  4. NOINDEX SURFACE — a deterministic (sorted, strided) bounded sample
     of the rule pages the committed tree marks ``noindex`` must serve
     ``noindex`` live, and a deterministic bounded sample of the ones it
     leaves indexable must NOT;
  5. byte-compare of every committed page against what is served.

This is intentionally NOT wired into any test/gate suite: it depends on
the network and on a live deploy existing, which are not properties of
the source tree. Run it by hand after a deploy:

    python3 verify_live.py            # checks https://verifyhash.com/einvoice
    python3 verify_live.py --base https://verifyhash.com/einvoice

Exit code 0 = all checks passed; 1 = at least one mismatch/failure. Every
discrepancy prints the URL together with BOTH values (expected vs live).

Zero third-party dependencies (stdlib only): urllib, hashlib, json, xml.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.request
import urllib.error
from xml.etree import ElementTree

HERE = os.path.dirname(os.path.abspath(__file__))
WWW = os.path.join(HERE, "www")
DEFAULT_BASE = "https://verifyhash.com/einvoice"
TIMEOUT = 15

def committed_pages():
    """Every page of the committed ``www/`` tree as (live sub-path, rel file).

    DERIVED, not hand-kept: one entry per ``www/**/index.html`` (the sub-path
    is the containing directory with a trailing slash, ``/`` for the root
    page) plus ``sitemap.xml`` and ``robots.txt``. Because the list is walked
    from disk, a future page family (the way ``/de/`` and ``/compare/`` were
    added) can never silently drop out of live verification.

    Pure local directory walk — NO network and no file reads; the committed
    bytes are only read later, inside main()'s byte-compare phase.
    ``test_verify_live_paths.py`` binds this mapping to the committed tree.
    """
    pairs = []
    for dirpath, dirnames, filenames in os.walk(WWW):
        dirnames.sort()
        if "index.html" not in filenames:
            continue
        rel = os.path.relpath(os.path.join(dirpath, "index.html"), WWW)
        rel = rel.replace(os.sep, "/")
        sub = "/" if rel == "index.html" else "/" + rel[: -len("index.html")]
        pairs.append((sub, rel))
    for extra in ("sitemap.xml", "robots.txt"):
        if os.path.isfile(os.path.join(WWW, extra)):
            pairs.append(("/" + extra, extra))
    return sorted(pairs)


# (live sub-path relative to base, committed file relative to www/) —
# the FULL committed surface, ~290+ pages; see committed_pages().
BYTE_COMPARE = committed_pages()

# paths that must serve 200 (same derived surface; byte-compare then also
# proves content identity on top of the plain 200)
SPOT_200 = [sub for sub, _rel in BYTE_COMPARE]

NOINDEX_RE = re.compile(rb"noindex", re.IGNORECASE)
CANONICAL_RE = re.compile(
    rb'<link[^>]*rel=["\']canonical["\'][^>]*href=["\']([^"\']+)["\']',
    re.IGNORECASE,
)

# --- text-level parsers, used by the parity checks below ------------------ #
# All of these run over BOTH the committed file and the live response with
# the SAME code, so a formatting difference can never masquerade as a
# content difference.
CANONICAL_TEXT_RE = re.compile(
    r'<link[^>]*rel=["\']canonical["\'][^>]*href=["\']([^"\']*)["\']',
    re.IGNORECASE)
META_TAG_RE = re.compile(r"<meta\b[^>]*>", re.IGNORECASE)
ATTR_RE = re.compile(
    r'([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|\'([^\']*)\')')
LDJSON_RE = re.compile(
    r'<script\b[^>]*\btype=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.S | re.IGNORECASE)
ROBOTS_META_RE = re.compile(
    r'<meta\b[^>]*\bname=["\']robots["\'][^>]*\bcontent=["\']([^"\']*)["\']',
    re.IGNORECASE)
# Prefixes of the link-preview ("card") tag namespaces. The tag NAMES are
# never listed here — they are read off each committed page — but a page
# that has lost og:title/og:url entirely would otherwise make this check
# vacuously green, so SHARE_FLOOR below is the anti-vacuity floor.
SHARE_PREFIXES = ("og:", "twitter:")
SHARE_FLOOR = ("og:title", "og:url")


def _text(data: bytes) -> str:
    return data.decode("utf-8", errors="replace")


def _read_committed(rel: str) -> str:
    with open(os.path.join(WWW, rel.replace("/", os.sep)),
              encoding="utf-8", errors="replace") as fh:
        return fh.read()


def _attrs(tag: str) -> dict:
    out = {}
    for m in ATTR_RE.finditer(tag):
        out[m.group(1).lower()] = m.group(2) if m.group(2) is not None else m.group(3)
    return out


def share_tags(html: str) -> dict:
    """``{'og:title': content, 'twitter:card': content, ...}`` for a page.

    DERIVED: every ``<meta>`` whose ``property=``/``name=`` starts with one
    of SHARE_PREFIXES is returned — the expected tag NAMES therefore come
    from the committed page itself, never from a list typed here (the
    authoritative list of required tags lives in test_share_metadata.py and
    is not duplicated).
    """
    tags = {}
    for m in META_TAG_RE.finditer(html):
        a = _attrs(m.group(0))
        key = a.get("property") or a.get("name")
        if key and key.lower().startswith(SHARE_PREFIXES):
            tags[key.lower()] = a.get("content", "")
    return tags


def _locs(data: bytes):
    """Every ``<loc>`` text in a sitemap document (raw, unnormalised)."""
    root = ElementTree.fromstring(data)
    return [el.text.strip() for el in root.iter()
            if el.tag.endswith("loc") and el.text]


def _norm_path(p: str) -> str:
    """Trailing-slash/whitespace normal form of a base-relative path."""
    return (p or "").strip().rstrip("/") or "/"


def canon_loc(url: str, base: str) -> str:
    """A ``<loc>`` reduced to its base-relative, normalised path.

    Applied identically to the committed side (with the committed base) and
    the live side (with ``--base``), so the two sets compare on CONTENT, not
    on origin spelling or trailing slashes. A URL that is not under its base
    is returned whole — an off-origin loc must show up as a difference, not
    be silently folded in.
    """
    u = (url or "").strip()
    b = (base or "").rstrip("/")
    if b and (u == b or u.startswith(b + "/")):
        return _norm_path(u[len(b):])
    return u.rstrip("/")


def committed_base() -> str:
    """The origin the committed tree was generated for (gen_site.BASE_URL).

    READ from the committed tree, never hard-coded: the ``Sitemap:`` line of
    ``www/robots.txt`` (which the generator builds from BASE_URL), falling
    back to the common prefix of the committed ``<loc>`` set, and finally to
    DEFAULT_BASE. Local file reads only.
    """
    robots = os.path.join(WWW, "robots.txt")
    if os.path.isfile(robots):
        with open(robots, encoding="utf-8", errors="replace") as fh:
            m = re.search(r"(?im)^\s*Sitemap:\s*(\S+)", fh.read())
        if m and m.group(1).endswith("/sitemap.xml"):
            return m.group(1)[: -len("/sitemap.xml")]
    locs = committed_locs()
    if locs:
        shortest = min(locs, key=len)
        if all(u.startswith(shortest) for u in locs):
            return shortest.rstrip("/")
    return DEFAULT_BASE


def committed_locs():
    """Every ``<loc>`` of the COMMITTED ``www/sitemap.xml`` (raw)."""
    path = os.path.join(WWW, "sitemap.xml")
    if not os.path.isfile(path):
        return []
    with open(path, "rb") as fh:
        try:
            return _locs(fh.read())
        except ElementTree.ParseError:
            return []


def sitemapped_pages():
    """``[(live sub-path, rel file)]`` for committed pages the committed
    sitemap lists — the intersection of committed_pages() and the committed
    ``<loc>`` set, both put through canon_loc/_norm_path first."""
    wanted = {canon_loc(u, committed_base()) for u in committed_locs()}
    return [(sub, rel) for sub, rel in committed_pages()
            if _norm_path(sub) in wanted]


def surface_pages():
    """The sitemapped pages that are NOT per-rule detail pages.

    Derived by shape (``rules/<ID>/index.html``), so the set follows the
    committed tree; today that is the eight hand-built surface pages
    (``/``, ``/rules/``, ``/walkthrough/``, ``/licensing/``, ``/compare/``,
    ``/validate/``, ``/de/``, ``/de/walkthrough/``) but nothing here says
    "eight" or names any of them.
    """
    return [(sub, rel) for sub, rel in sitemapped_pages()
            if not (rel.startswith("rules/") and rel != "rules/index.html")]


def robots_partition():
    """``(noindex, indexable)`` rule-detail pages per the COMMITTED tree.

    Local file reads only; the live side is fetched in main().
    """
    noindex, indexable = [], []
    for sub, rel in committed_pages():
        if not rel.startswith("rules/") or rel == "rules/index.html":
            continue
        m = ROBOTS_META_RE.search(_read_committed(rel))
        content = m.group(1) if m else ""
        (noindex if "noindex" in content.lower() else indexable).append(
            (sub, rel, content or "<no robots meta>"))
    return noindex, indexable


def stride_sample(items, n):
    """A DETERMINISTIC bounded sample: sorted input, strided, capped at n.

    Never random — two runs against the same tree report the same pages, so
    a finding can be reproduced and a fix confirmed.
    """
    if not items or n <= 0:
        return []
    step = max(1, len(items) // n)
    return sorted(items)[::step][:n]


def _get(url: str):
    """GET url; return (status, body_bytes). Never raises for HTTP errors."""
    req = urllib.request.Request(url, headers={"User-Agent": "einvoice-verify-live/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return resp.getcode(), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, b""
    except Exception as e:  # network/DNS/timeout
        return None, ("%s: %s" % (type(e).__name__, e)).encode()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", default=DEFAULT_BASE,
                    help="live origin+subpath, default %s" % DEFAULT_BASE)
    ap.add_argument("--sitemap-sample", type=int, default=12,
                    help="how many sitemap <loc> URLs to spot-check (default 12)")
    ap.add_argument("--robots-sample", type=int, default=8,
                    help="how many committed-noindex and how many committed-"
                         "indexable rule pages to check live (default 8 each)")
    args = ap.parse_args()
    base = args.base.rstrip("/")
    origin_prefix = base.encode()

    failures = []  # human-readable strings

    # 1. spot-check 200s
    print("== spot-check HTTP 200 ==")
    for p in SPOT_200:
        code, _ = _get(base + p)
        ok = code == 200
        print("  %s  %s%s" % (code, base, p))
        if not ok:
            failures.append("path %s served %s (expected 200)" % (p, code))

    # 2. sitemap sample
    print("== sitemap <loc> sample ==")
    code, body = _get(base + "/sitemap.xml")
    locs = []
    if code == 200 and body:
        try:
            root = ElementTree.fromstring(body)
            locs = [el.text.strip() for el in root.iter()
                    if el.tag.endswith("loc") and el.text]
        except ElementTree.ParseError as e:
            failures.append("sitemap.xml did not parse: %s" % e)
    else:
        failures.append("sitemap.xml served %s" % code)
    off_origin = [u for u in locs if not u.encode().startswith(origin_prefix)]
    if off_origin:
        failures.append("%d sitemap loc(s) not on live origin, e.g. %s"
                        % (len(off_origin), off_origin[0]))
    n = max(1, args.sitemap_sample)
    step = max(1, len(locs) // n) if locs else 1
    sample = locs[::step][:n]
    checked = 0
    for u in sample:
        c, _ = _get(u)
        checked += 1
        mark = "ok" if c == 200 else "FAIL"
        print("  %s  %s  %s" % (c, mark, u))
        if c != 200:
            failures.append("sitemap url %s served %s" % (u, c))
    print("  total locs=%d  sampled=%d  off_origin=%d" % (len(locs), checked, len(off_origin)))

    # 2b. SITEMAP_LOC_PARITY — the WHOLE live <loc> set vs the WHOLE
    # committed <loc> set. This is the check that catches "the deploy is
    # stale": a live sitemap still advertising the pre-T-VHCRAWL.3 surface
    # while the committed one lists the collapsed set differs here by
    # hundreds of URLs, which the 12-URL sample above cannot see.
    print("== SITEMAP_LOC_PARITY: full committed <loc> set vs full live set ==")
    cbase = committed_base()
    exp_raw = committed_locs()
    expected_locs = {canon_loc(u, cbase) for u in exp_raw}
    live_locs = {canon_loc(u, base) for u in locs}
    print("  committed base=%s  live base=%s" % (cbase, base))
    print("  committed locs=%d  live locs=%d" % (len(expected_locs), len(live_locs)))
    if not expected_locs:
        failures.append("SITEMAP_LOC_PARITY: the COMMITTED www/sitemap.xml "
                        "yielded 0 <loc> entries — this check would be "
                        "vacuous; fix the committed sitemap first")
        print("  SKIP: committed sitemap yielded no <loc> (FAIL)")
    elif code != 200:
        print("  SKIP: live sitemap could not be fetched (already reported)")
    else:
        missing_live = sorted(expected_locs - live_locs)
        extra_live = sorted(live_locs - expected_locs)
        for p in missing_live:
            print("  MISSING-LIVE  %s   expected=%s   live=<absent>"
                  % (p, cbase + p if p.startswith("/") else p))
        for p in extra_live:
            print("  EXTRA-LIVE    %s   expected=<absent>   live=%s"
                  % (p, base + p if p.startswith("/") else p))
        if missing_live or extra_live:
            failures.append(
                "SITEMAP_LOC_PARITY: live sitemap.xml <loc> set != committed "
                "(%d committed vs %d live; %d missing-live e.g. %s; %d "
                "extra-live e.g. %s) — redeploy needed"
                % (len(expected_locs), len(live_locs), len(missing_live),
                   missing_live[0] if missing_live else "-", len(extra_live),
                   extra_live[0] if extra_live else "-"))
        else:
            print("  SITEMAP_LOC_PARITY: EQUAL (%d loc(s), both directions)"
                  % len(expected_locs))

    # 2c. share + structured-data parity on the sitemapped surface pages.
    # The link-preview card is one-shot: the announce URL that unfurls as
    # bare grey text does not get a second first impression, so the tags
    # have to be proven ON THE LIVE ORIGIN, not just in the tree.
    print("== share + structured-data parity (sitemapped surface pages) ==")
    surfaces = surface_pages()
    if not surfaces:
        failures.append("no sitemapped surface pages derived from the "
                        "committed tree — the share check would be vacuous")
        print("  SKIP: derived 0 surface pages (FAIL)")
    for sub, rel in surfaces:
        url = base + sub
        want = share_tags(_read_committed(rel))
        missing_floor = [k for k in SHARE_FLOOR if k not in want]
        if missing_floor:
            failures.append("committed www/%s carries no %s — its link "
                            "preview is broken at the source"
                            % (rel, ", ".join(missing_floor)))
            print("  FAIL  %s  committed page lacks %s"
                  % (sub, ", ".join(missing_floor)))
            continue
        c, raw = _get(url)
        if c != 200 or not raw:
            failures.append("%s served %s during share parity" % (sub, c))
            print("  FAIL  %s  fetch %s" % (sub, c))
            continue
        live_html = _text(raw)
        got = share_tags(live_html)
        bad = []
        for key in sorted(want):
            # URL-valued tags are rebased onto --base, so pointing the
            # checker at a staging origin does not report every og:url as a
            # content difference.
            expect = want[key]
            if expect.startswith(cbase):
                expect = base + expect[len(cbase):]
            if key not in got:
                bad.append("%s: expected=%r live=<tag absent>" % (key, expect))
            elif got[key] != expect:
                bad.append("%s: expected=%r live=%r" % (key, expect, got[key]))
        blocks = LDJSON_RE.findall(live_html)
        if len(blocks) != 1:
            bad.append("application/ld+json: expected=1 block live=%d blocks"
                       % len(blocks))
        else:
            try:
                json.loads(blocks[0])
            except Exception as exc:  # noqa: BLE001 — any parse failure is a FAIL
                bad.append("application/ld+json: expected=parseable JSON "
                           "live=unparseable (%s: %s)" % (type(exc).__name__, exc))
        m = CANONICAL_TEXT_RE.search(live_html)
        live_canon = m.group(1) if m else None
        if live_canon is None:
            bad.append("canonical: expected=<link rel=canonical> live=<absent>")
        elif got.get("og:url") != live_canon:
            bad.append("og:url != canonical: expected=%r live og:url=%r"
                       % (live_canon, got.get("og:url")))
        if bad:
            print("  FAIL  %s" % url)
            for b in bad:
                print("          %s" % b)
                failures.append("%s: %s" % (url, b))
        else:
            print("  ok    %s  (%d share tag(s), 1 ld+json parsed, "
                  "og:url == canonical)" % (url, len(want)))

    # 2d. noindex surface parity — the crawl surface the redeploy exists to
    # fix. Deterministic strided samples of BOTH sides of the committed
    # partition, so a run is reproducible and a live tree that serves the
    # OLD (all-indexable, or all-noindex) robots meta is caught either way.
    print("== noindex surface parity (deterministic samples) ==")
    ni, ix = robots_partition()
    print("  committed: %d noindex rule page(s), %d indexable" % (len(ni), len(ix)))
    if not ni or not ix:
        failures.append("committed rule pages do not split into BOTH a "
                        "noindex and an indexable set (%d/%d) — the crawl "
                        "surface check would be vacuous" % (len(ni), len(ix)))
    for expect_noindex, group in ((True, stride_sample(ni, args.robots_sample)),
                                  (False, stride_sample(ix, args.robots_sample))):
        for sub, _rel, committed_robots in group:
            url = base + sub
            c, raw = _get(url)
            if c != 200 or not raw:
                failures.append("%s served %s during noindex parity" % (sub, c))
                print("  FAIL  %s  fetch %s" % (sub, c))
                continue
            m = ROBOTS_META_RE.search(_text(raw))
            live_robots = m.group(1) if m else "<no robots meta>"
            live_noindex = "noindex" in live_robots.lower()
            if live_noindex == expect_noindex:
                print("  ok    %s  robots=%r" % (url, live_robots))
            else:
                print("  FAIL  %s  expected=%r live=%r"
                      % (url, committed_robots, live_robots))
                failures.append(
                    "%s: committed robots meta is %r (%sindexable) but live "
                    "serves %r — the crawl surface on the live origin does "
                    "not match the committed tree"
                    % (url, committed_robots, "non-" if expect_noindex else "",
                       live_robots))

    # 3. noindex / canonical on the index
    print("== noindex / canonical ==")
    code, home = _get(base + "/")
    if code == 200 and home:
        if NOINDEX_RE.search(home):
            failures.append("live index contains a 'noindex' token (staging leak?)")
            print("  noindex: FOUND (FAIL)")
        else:
            print("  noindex: absent (ok)")
        m = CANONICAL_RE.search(home)
        if not m:
            print("  canonical: none present")
        else:
            href = m.group(1)
            good = href.startswith(origin_prefix)
            print("  canonical: %s  (%s)" % (href.decode(errors="replace"),
                                             "ok" if good else "FAIL"))
            if not good:
                failures.append("canonical href %r not on live origin" % href.decode(errors="replace"))
    else:
        failures.append("could not fetch index for meta checks (%s)" % code)

    # 4. byte-compare live vs committed
    print("== byte-compare live vs committed www/ ==")
    for sub, rel in BYTE_COMPARE:
        cpath = os.path.join(WWW, rel)
        if not os.path.exists(cpath):
            failures.append("committed file missing: www/%s" % rel)
            print("  MISSING committed www/%s" % rel)
            continue
        code, live = _get(base + sub)
        if code != 200 or not live:
            failures.append("%s served %s during byte-compare" % (sub, code))
            print("  %s  fetch %s" % (code, sub))
            continue
        with open(cpath, "rb") as fh:
            committed = fh.read()
        lh = hashlib.sha256(live).hexdigest()
        ch = hashlib.sha256(committed).hexdigest()
        same = lh == ch
        print("  %-11s %s  (live=%d committed=%d)"
              % ("IDENTICAL" if same else "DIFF", sub, len(live), len(committed)))
        if not same:
            failures.append("live %s differs from committed www/%s "
                            "(stale/partial deploy — redeploy needed)" % (sub, rel))

    print()
    if failures:
        print("RESULT: %d finding(s) — deploy NOT clean:" % len(failures))
        for f in failures:
            print("  - %s" % f)
        return 1
    print("RESULT: PASS — live matches committed www/, no staging leak.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

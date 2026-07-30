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
  5. byte-compare of every committed page against what is served;
  6. ENGINE BUNDLE — the browser validator's executable Pyodide payload
     (``/validate/engine/``), its inventory derived from the committed
     ``manifest.json``'s own ``files`` list. The live manifest is compared
     on three axes: top-level ``version``, the ``files`` list (both
     directions), and — the primary one — the SEPARATE top-level
     ``sha256`` MAP, name by name; a stale deploy typically ships an
     identical files list with a few older digests, so a list-only diff
     reports "identical" and sees nothing. Every declared file is then
     fetched: 200, non-empty, and matching the live manifest's own claim.

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


# The browser validator's executable payload. ``committed_pages()`` walks
# ``**/index.html`` only, so before this inventory existed the ONLY files on
# the site that are actually EXECUTED (the Pyodide bundle the /validate/ page
# loads) were invisible to live verification: a stale bundle serves
# byte-identical HTML and is only visible in these digests.
ENGINE_DIR = "validate/engine"
ENGINE_MANIFEST_REL = ENGINE_DIR + "/manifest.json"


def committed_engine_manifest() -> dict:
    """Parsed contents of the committed ``www/validate/engine/manifest.json``.

    Plain local file read, no network — the module stays import-pure exactly
    as ``committed_pages()`` is. A missing or unparseable manifest returns
    ``{}`` rather than raising, so importing the module can never blow up on
    a tree that ships no engine bundle; main() turns the empty inventory into
    a reported finding instead.
    """
    path = os.path.join(WWW, *ENGINE_MANIFEST_REL.split("/"))
    try:
        with open(path, "rb") as fh:
            data = json.loads(fh.read().decode("utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def committed_engine_files(manifest: dict | None = None):
    """(live sub-path, committed rel path) for every file the manifest declares.

    DERIVED FROM THE MANIFEST'S OWN ``files`` list — never a hard-coded list
    of names. The bundle's closure changes whenever the engine does (today 19
    entries), and a literal list here would reproduce exactly the blindness
    this inventory removes. ``manifest.json`` itself is NOT one of the
    entries; main() fetches it separately.
    """
    if manifest is None:
        manifest = committed_engine_manifest()
    pairs = []
    for name in _engine_names(manifest):
        pairs.append(("/" + ENGINE_DIR + "/" + name, ENGINE_DIR + "/" + name))
    return sorted(pairs)


def _engine_names(manifest) -> set:
    """The set of file NAMES a manifest's ``files`` list declares."""
    if not isinstance(manifest, dict):
        return set()
    files = manifest.get("files")
    if not isinstance(files, (list, tuple)):
        return set()
    return {n for n in files if isinstance(n, str) and n}


def _engine_digests(manifest) -> dict:
    """The name -> sha256 map a manifest declares (SEPARATE from ``files``)."""
    if not isinstance(manifest, dict):
        return {}
    digests = manifest.get("sha256")
    if not isinstance(digests, dict):
        return {}
    return {k: v for k, v in digests.items() if isinstance(k, str)}


def compare_engine_manifests(committed, live):
    """Compare two engine manifests. PURE — dicts in, findings out, no I/O.

    Returns ``(missing, extra, digest_mismatches, version_mismatch)``:
    names only the committed ``files`` list has; names only the live one
    has; ``(name, expected_sha256, live_sha256)`` per name whose entry in
    the SEPARATE top-level ``sha256`` MAP disagrees (``live_sha256`` is
    ``None`` when the live side declares the file but no digest for it);
    and ``None`` or ``(committed_version, live_version)``.

    THE MAP COMPARISON IS THE PRIMARY ONE. A stale deploy typically ships an
    IDENTICAL ``files`` list (same 19 names) with a handful of digests from
    the older build — diffing only the list prints "identical, 0 mismatches"
    and is precisely the bug this function exists to make impossible.
    """
    cnames = _engine_names(committed)
    lnames = _engine_names(live)
    missing = sorted(cnames - lnames)
    extra = sorted(lnames - cnames)

    cdig = _engine_digests(committed)
    ldig = _engine_digests(live)
    digest_mismatches = []
    for name in sorted(cnames | set(cdig)):
        want = cdig.get(name)
        if want is None:
            continue  # committed pins no digest for it — nothing to compare
        if name not in lnames and name not in ldig:
            continue  # already reported as missing; not a second finding
        got = ldig.get(name)
        if got != want:
            digest_mismatches.append((name, want, got))

    cver = committed.get("version") if isinstance(committed, dict) else None
    lver = live.get("version") if isinstance(live, dict) else None
    version_mismatch = None if cver == lver else (cver, lver)
    return missing, extra, digest_mismatches, version_mismatch


# (live sub-path relative to base, committed file relative to www/) —
# the FULL committed surface, ~290+ pages; see committed_pages().
BYTE_COMPARE = committed_pages()

# The executable bundle, derived from the committed manifest's own files list.
ENGINE_MANIFEST = committed_engine_manifest()
ENGINE_FILES = committed_engine_files(ENGINE_MANIFEST)

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


def committed_share_assets():
    """Non-page files the committed HTML advertises to link-preview crawlers.

    Returns ``[(live sub-path, rel file under www/), ...]`` — today exactly
    one entry, the Open Graph card ``www/og-card.png`` (T-VHSHARE.4).

    WHY THIS EXISTS. Every other live check in this script is driven by
    ``committed_pages()``, which walks for ``index.html`` — so the card, the
    only non-HTML file the site advertises, was invisible to verification. It
    is also the one asset whose absence a human cannot spot: no page links to
    it, so a deploy that dropped it renders a perfect-looking site while every
    LinkedIn/XING/Reddit unfurl of the announce shows a blank tile. The
    announce is one-shot.

    DERIVED, never hand-kept: the URL is read from the ``og:image`` the
    committed landing page actually emits, and only accepted when it is on the
    committed base AND resolves to a file in the tree. So a renamed card
    follows automatically; a card pointed at a third-party CDN is not claimed
    as ours to verify; and if the image metas are ever dropped this returns
    ``[]`` and the phase self-disables rather than demanding a URL the tree
    does not ship.
    """
    landing = os.path.join(WWW, "index.html")
    if not os.path.isfile(landing):
        return []
    with open(landing, "rb") as fh:
        tags = share_tags(_text(fh.read()))
    cbase = committed_base().rstrip("/")
    out = {}
    for key in ("og:image", "twitter:image"):
        url = tags.get(key, "")
        if not url or not cbase or not url.startswith(cbase + "/"):
            continue
        rel = url[len(cbase) + 1:]
        if not rel or "?" in rel or ".." in rel:
            continue
        if os.path.isfile(os.path.join(WWW, rel.replace("/", os.sep))):
            out["/" + rel] = rel
    return sorted(out.items())


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

    # 4b. SHARE ASSETS — the og:image card. Same byte-compare discipline as
    # the pages above, on a file no page links to (see
    # committed_share_assets()): a 404 or a stale card here is invisible in a
    # browser and fatal to the one-shot announce.
    share_assets = committed_share_assets()
    print("== share assets (og:image card) live vs committed ==")
    if not share_assets:
        # Not a failure: the site is allowed to ship without a card. It IS
        # reported, so a card that silently stopped being advertised does not
        # look like a clean run.
        print("  none advertised by the committed landing page — nothing to "
              "check (the site ships no og:image)")
    for sub, rel in share_assets:
        cpath = os.path.join(WWW, rel)
        code, live = _get(base + sub)
        if code != 200 or not live:
            failures.append(
                "share asset %s served %s (expected 200) — pages advertise it "
                "as og:image, so every social unfurl would render a blank tile"
                % (sub, code))
            print("  %s  fetch %s" % (code, sub))
            continue
        with open(cpath, "rb") as fh:
            committed = fh.read()
        same = (hashlib.sha256(live).hexdigest()
                == hashlib.sha256(committed).hexdigest())
        print("  %-11s %s  (live=%d committed=%d)"
              % ("IDENTICAL" if same else "DIFF", sub, len(live),
                 len(committed)))
        if not same:
            failures.append("live share asset %s differs from committed www/%s "
                            "(stale card — redeploy needed)" % (sub, rel))

    # 5. ENGINE BUNDLE — the only files on the site that are EXECUTED. The
    #    /validate/ page loads this Pyodide payload and pins each file on its
    #    sha256, so a partial deploy hard-stops the validator; a fully stale
    #    one silently runs older rules while every HTML page byte-compares
    #    clean (version strings of equal length do not change page size).
    #    The digest MAP is the primary comparison: the files LIST stays
    #    identical across builds and sees nothing.
    print("== engine bundle (browser validator) live vs committed ==")
    if not ENGINE_FILES:
        failures.append(
            "committed www/%s declares no files — the engine bundle inventory "
            "is empty, so nothing about the executed browser validator is "
            "verified" % ENGINE_MANIFEST_REL)
        print("  MISSING committed www/%s (absent, unparseable, or empty "
              "'files' list)" % ENGINE_MANIFEST_REL)

    live_manifest = None
    code, body = _get(base + "/" + ENGINE_MANIFEST_REL)
    if code != 200 or not body:
        failures.append(
            "engine manifest /%s served %s (expected 200) — the browser "
            "validator cannot verify its own bundle without it"
            % (ENGINE_MANIFEST_REL, code))
        print("  %s  fetch /%s" % (code, ENGINE_MANIFEST_REL))
    else:
        try:
            parsed = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as e:
            parsed = None
            failures.append("live /%s did not parse as JSON: %s"
                            % (ENGINE_MANIFEST_REL, e))
            print("  UNPARSEABLE /%s (%d bytes)"
                  % (ENGINE_MANIFEST_REL, len(body)))
        if parsed is not None and not isinstance(parsed, dict):
            failures.append("live /%s parsed as %s, expected a JSON object"
                            % (ENGINE_MANIFEST_REL, type(parsed).__name__))
            print("  UNPARSEABLE /%s (not a JSON object)" % ENGINE_MANIFEST_REL)
        elif parsed is not None:
            live_manifest = parsed

    if live_manifest is not None:
        missing, extra, digest_diffs, version_mismatch = \
            compare_engine_manifests(ENGINE_MANIFEST, live_manifest)
        if version_mismatch:
            cver, lver = version_mismatch
            print("  VERSION     committed=%r live=%r" % (cver, lver))
            failures.append(
                "engine bundle VERSION disagrees: committed %r, live %r — the "
                "browser validator is executing a different build than the "
                "committed tree (redeploy needed)" % (cver, lver))
        else:
            print("  VERSION     %r (agrees)" % (ENGINE_MANIFEST.get("version"),))
        print("  FILES       committed=%d live=%d"
              % (len(_engine_names(ENGINE_MANIFEST)),
                 len(_engine_names(live_manifest))))
        for name in missing:
            print("  MISSING     %s (committed declares it, live does not)" % name)
            failures.append(
                "engine file %s is declared by the committed manifest but not "
                "by the live one (incomplete deploy)" % name)
        for name in extra:
            print("  EXTRA       %s (live declares it, committed does not)" % name)
            failures.append(
                "live engine manifest declares %s, which the committed "
                "manifest does not (stale file left behind)" % name)
        for name, want, got in digest_diffs:
            print("  DIFF        %s/%s" % (ENGINE_DIR, name))
            print("              expected %s" % want)
            print("              live     %s" % got)
            failures.append(
                "engine file %s sha256 disagrees: committed %s, live %s "
                "(stale/partial deploy — redeploy needed)" % (name, want, got))
        if not (missing or extra or digest_diffs):
            print("  IDENTICAL   %d file(s), sha256 map agrees"
                  % len(_engine_names(ENGINE_MANIFEST)))

    # Each file the COMMITTED manifest declares must actually be served, and
    # the served bytes must match the LIVE manifest's own declared digest —
    # a self-inconsistent bundle is the partial-deploy case that makes the
    # validator page refuse to start.
    live_digests = _engine_digests(live_manifest)
    for sub, rel in ENGINE_FILES:
        code, live = _get(base + sub)
        if code != 200 or not live:
            failures.append(
                "engine file %s served %s (expected 200 with a non-empty "
                "body) — the browser validator hard-stops on a missing bundle "
                "file" % (sub, code))
            print("  %s  fetch %s" % (code, sub))
            continue
        name = rel.rsplit("/", 1)[-1]
        served = hashlib.sha256(live).hexdigest()
        declared = live_digests.get(name)
        if declared is not None and declared != served:
            print("  SELF-DIFF   %s" % sub)
            print("              declared %s" % declared)
            print("              served   %s" % served)
            failures.append(
                "engine file %s does not match the LIVE manifest's own sha256 "
                "(declared %s, served %s) — the validator page pins each file "
                "and will refuse to load" % (sub, declared, served))
        else:
            print("  200         %s (%d bytes)" % (sub, len(live)))

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

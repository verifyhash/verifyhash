#!/usr/bin/env python3
"""Post-deploy live verification for the einvoice reference surface.

READ-ONLY: issues plain HTTP GET requests against the live origin and
compares what is served against the committed ``www/`` tree. It NEVER
edits live content and NEVER touches the deploy pipeline — a mismatch is
reported as a finding (redeploy needed), not fixed here.

This is intentionally NOT wired into any test/gate suite: it depends on
the network and on a live deploy existing, which are not properties of
the source tree. Run it by hand after a deploy:

    python3 verify_live.py            # checks https://verifyhash.com/einvoice
    python3 verify_live.py --base https://verifyhash.com/einvoice

Exit code 0 = all checks passed; 1 = at least one mismatch/failure.

Zero third-party dependencies (stdlib only): urllib, hashlib, xml.
"""
from __future__ import annotations

import argparse
import hashlib
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

# (live sub-path relative to base, committed file relative to www/)
BYTE_COMPARE = [
    ("/", "index.html"),
    ("/rules/", "rules/index.html"),
    ("/rules/BR-DE-15/", "rules/BR-DE-15/index.html"),
    ("/rules/BR-DE-CVD-01/", "rules/BR-DE-CVD-01/index.html"),
    ("/rules/PEPPOL-EN16931-R001/", "rules/PEPPOL-EN16931-R001/index.html"),
    ("/walkthrough/", "walkthrough/index.html"),
    ("/sitemap.xml", "sitemap.xml"),
    ("/robots.txt", "robots.txt"),
]

# paths that must serve 200 (superset of the byte-compared ones)
SPOT_200 = [
    "/", "/rules/", "/rules/BR-DE-15/", "/rules/BR-DE-CVD-01/",
    "/rules/PEPPOL-EN16931-R001/", "/walkthrough/",
    "/sitemap.xml", "/robots.txt",
]

NOINDEX_RE = re.compile(rb"noindex", re.IGNORECASE)
CANONICAL_RE = re.compile(
    rb'<link[^>]*rel=["\']canonical["\'][^>]*href=["\']([^"\']+)["\']',
    re.IGNORECASE,
)


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

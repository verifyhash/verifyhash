#!/usr/bin/env python3
"""test_link_graph.py — internal-link-graph integrity over the generated
einvoice reference site (``einvoice/www/``).

This is DELIBERATELY disjoint from ``test_site.py`` section (e), which already
guards: no dangling internal href, ``sitemap.xml`` == the generated canonical
set (with a single ISO ``<lastmod>``), and ``robots.txt`` -> that sitemap. Those
checks prove every *edge* points somewhere real; they do NOT prove the *graph*
is connected, nor that the commercial call-to-action wiring is intact. This file
adds exactly two new guards:

  (1) REACHABILITY / no-orphan (BFS): build a directed internal-link graph over
      every generated HTML page (landing, hub, walkthrough, licensing, and every
      ``www/rules/<ID>/index.html``). Edges are the internal hrefs on each page
      (external http/https/mailto and pure ``#`` fragments are not edges;
      ``#frag`` / ``?query`` are stripped; targets resolve via
      ``os.path.realpath`` relative to the linking file's directory). BFS from
      the rule index hub (``www/rules/index.html``) AND from the landing
      (``www/index.html``); assert EVERY rule page is reachable within 2 hops of
      the hub (hub->rule counts as 1 hop). A rule page that exists on disk and is
      listed in the sitemap but is unreachable is reported as an ORPHAN.

  (2) CTA cross-link presence + resolution: every generated rule page must carry
      the T-BUY.2 call-to-action block links, and each must resolve to a REAL
      generated target:
        - ``../../licensing/index.html`` -> the licensing file exists on disk;
        - ``../../index.html#onramp``    -> the landing file exists AND an
                                            ``id="onramp"`` fragment target is
                                            present on that landing page;
        - ``#de``                        -> an element with ``id="de"`` exists on
                                            the SAME rule page (same-page anchor).

Standard library only; no network. Run from the einvoice dir:

    python3 test_link_graph.py
"""

from __future__ import annotations

import collections
import html
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

from einvoice import remediation as _remediation  # noqa: E402
import gen_site as _gen                            # noqa: E402

WWW_DIR = os.path.join(HERE, "www")
RULES_DIR = os.path.join(WWW_DIR, "rules")

_HREF_RE = re.compile(r'\bhref="([^"]*)"', re.IGNORECASE)


def _internal_targets(page, base_dir):
    """Yield (raw_href, resolved_realpath) for every INTERNAL, file-bearing href
    on a page. External (http/https/mailto) hrefs and pure in-page fragments
    (``#id``) carry no file target and are skipped; ``#frag`` and ``?query`` are
    stripped before resolving relative to ``base_dir`` via os.path.realpath."""
    for raw in _HREF_RE.findall(page):
        href = html.unescape(raw)
        if href.startswith(("http://", "https://", "mailto:", "#")):
            continue
        target = href.split("#", 1)[0].split("?", 1)[0]
        if not target:
            continue
        yield href, os.path.realpath(os.path.join(base_dir, target))


def main():
    failures = []

    def check(cond, msg):
        if not cond:
            failures.append(msg)

    # ---- the generated tree must exist (gen_site.py --check keeps it fresh) --
    landing_path = os.path.join(WWW_DIR, "index.html")
    hub_path = os.path.join(RULES_DIR, "index.html")
    walkthrough_path = os.path.join(WWW_DIR, "walkthrough", "index.html")
    licensing_path = os.path.join(WWW_DIR, "licensing", "index.html")
    for pth, name in ((landing_path, "www/index.html"),
                      (hub_path, "www/rules/index.html"),
                      (walkthrough_path, "www/walkthrough/index.html"),
                      (licensing_path, "www/licensing/index.html")):
        check(os.path.exists(pth),
              "surface file missing (run gen_site.py first): %s" % name)
    if failures:
        # Nothing else can be checked without the tree.
        for m in failures:
            sys.stderr.write("  !! " + m + "\n")
        sys.stderr.write("LINK-GRAPH TEST: FAIL (%d)\n" % len(failures))
        return 1

    # Rule pages: the ID set comes LIVE from the remediation catalog (never a
    # magic number), intersected with the dirs that actually carry an
    # index.html — the exact same source-of-truth test_site.py section (a) uses.
    catalog = _remediation.load_catalog()
    rule_ids = sorted(
        rid for rid in catalog
        if os.path.exists(os.path.join(RULES_DIR, rid, "index.html")))
    check(bool(rule_ids), "no generated rule pages found under www/rules/")
    rule_paths = {rid: os.path.join(RULES_DIR, rid, "index.html")
                  for rid in rule_ids}

    # Every generated HTML node in the site graph.
    node_paths = [landing_path, hub_path, walkthrough_path, licensing_path]
    node_paths += [rule_paths[rid] for rid in rule_ids]
    nodes = {os.path.realpath(p) for p in node_paths}

    hub_real = os.path.realpath(hub_path)
    landing_real = os.path.realpath(landing_path)
    licensing_real = os.path.realpath(licensing_path)
    rule_real = {rid: os.path.realpath(rule_paths[rid]) for rid in rule_ids}

    # ---- build the directed internal-link graph ----------------------------
    # An edge exists from page A to page B iff A carries an internal href that
    # resolves to B, and B is one of our generated nodes. (Links to files that
    # are not generated site nodes are already dangling-checked by test_site.)
    adj = collections.defaultdict(set)
    for p in node_paths:
        rp = os.path.realpath(p)
        page = open(p, encoding="utf-8").read()
        base = os.path.dirname(p)
        for _href, resolved in _internal_targets(page, base):
            if resolved in nodes and resolved != rp:
                adj[rp].add(resolved)

    def bfs_hops(start):
        """Minimum hop count from ``start`` to every reachable node."""
        dist = {start: 0}
        q = collections.deque([start])
        while q:
            cur = q.popleft()
            for nxt in adj[cur]:
                if nxt not in dist:
                    dist[nxt] = dist[cur] + 1
                    q.append(nxt)
        return dist

    # ---- (1) REACHABILITY / no-orphan: BFS from the hub AND the landing -----
    hub_dist = bfs_hops(hub_real)
    landing_dist = bfs_hops(landing_real)

    # Sitemap loc set, mapped back to files — a rule that is on disk AND in the
    # sitemap but unreachable is a genuine ORPHAN (indexed yet unnavigable).
    sitemap_locs = set()
    sitemap_path = os.path.join(WWW_DIR, "sitemap.xml")
    if os.path.exists(sitemap_path):
        sm = open(sitemap_path, encoding="utf-8").read()
        sitemap_locs = {html.unescape(x)
                        for x in re.findall(r"<loc>(.*?)</loc>", sm, re.S)}

    orphans = []          # rule pages unreachable within 2 hops of the hub
    unreachable_land = []  # rule pages the landing cannot reach at all
    for rid in rule_ids:
        rr = rule_real[rid]
        d = hub_dist.get(rr)
        in_sitemap = _gen._url_rule(rid) in sitemap_locs if sitemap_locs else True
        if d is None or d > 2:
            # Only flag as an orphan when the page is also advertised in the
            # sitemap (it claims to be a live, indexable destination).
            if in_sitemap:
                orphans.append("%s (hub-hops=%s)" % (rid, d))
        if landing_real not in landing_dist or rr not in landing_dist:
            unreachable_land.append(rid)

    check(not orphans,
          "ORPHAN rule pages unreachable within 2 hops of the hub: %s"
          % orphans[:10])
    # The landing must reach the hub (the whole rule surface hangs off it), and
    # through it every rule page — full-site connectivity from the front door.
    check(hub_real in landing_dist,
          "landing (www/index.html) cannot reach the rule hub at all")
    check(not unreachable_land,
          "rule pages the landing cannot reach through the graph: %s"
          % unreachable_land[:10])

    # ---- (2) CTA cross-link presence + resolution --------------------------
    # The landing must expose the on-ramp fragment target the rule CTAs point at.
    landing_page = open(landing_path, encoding="utf-8").read()
    landing_has_onramp = re.search(r'\bid="onramp"', landing_page) is not None
    check(landing_has_onramp,
          "landing page has no id=\"onramp\" fragment target for the CTA")

    LIC_HREF = "../../licensing/index.html"
    ONRAMP_HREF = "../../index.html#onramp"
    DE_HREF = "#de"

    for rid in rule_ids:
        page = open(rule_paths[rid], encoding="utf-8").read()
        base = os.path.dirname(rule_paths[rid])
        hrefs = {html.unescape(h) for h in _HREF_RE.findall(page)}

        # (a) licensing CTA link present AND resolves to the real licensing file.
        check(LIC_HREF in hrefs,
              "%s: missing licensing CTA link %r" % (rid, LIC_HREF))
        if LIC_HREF in hrefs:
            resolved = os.path.realpath(os.path.join(base, LIC_HREF))
            check(resolved == licensing_real and os.path.exists(resolved),
                  "%s: licensing CTA %r does not resolve to the generated "
                  "licensing page" % (rid, LIC_HREF))

        # (b) quickstart on-ramp CTA link present; landing file exists AND its
        #     id="onramp" fragment target is present (checked once above).
        check(ONRAMP_HREF in hrefs,
              "%s: missing quickstart on-ramp CTA link %r" % (rid, ONRAMP_HREF))
        if ONRAMP_HREF in hrefs:
            resolved = os.path.realpath(
                os.path.join(base, ONRAMP_HREF.split("#", 1)[0]))
            check(resolved == landing_real and os.path.exists(resolved),
                  "%s: on-ramp CTA %r does not resolve to the landing page"
                  % (rid, ONRAMP_HREF))
            check(landing_has_onramp,
                  "%s: on-ramp CTA targets #onramp but landing lacks that id"
                  % rid)

        # (c) German-remediation CTA is a SAME-PAGE anchor: the #de fragment must
        #     have a matching id="de" element on this very rule page.
        check(DE_HREF in hrefs,
              "%s: missing German-remediation CTA link %r" % (rid, DE_HREF))
        if DE_HREF in hrefs:
            check(re.search(r'\bid="de"', page) is not None,
                  "%s: CTA links #de but the page has no id=\"de\" target"
                  % rid)

    if failures:
        sys.stderr.write("LINK-GRAPH TEST: FAIL (%d)\n" % len(failures))
        for m in failures[:40]:
            sys.stderr.write("  !! " + m + "\n")
        return 1
    print("link-graph OK: %d rule pages, all reachable within 2 hops of the "
          "hub (0 orphans) and from the landing; every page carries the 3 CTA "
          "links (licensing / quickstart#onramp / #de), each resolving to a "
          "real generated target." % len(rule_ids))
    return 0


if __name__ == "__main__":
    sys.exit(main())

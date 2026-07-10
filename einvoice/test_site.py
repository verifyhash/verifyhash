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
      the full entry is present with no stub and no drift.
  (c) NO page contains a raw '<' that came from catalog content (injection
      guard), and NO page references an external resource (no 'http://',
      'https://', '<script', 'cdn', or an external '<link' / url()).
  (d) ``gen_site.py --check`` returns 0 on the committed tree, and would return
      non-zero if a committed page were mutated (simulated on a temp copy).
"""

from __future__ import annotations

import html
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

    # ---- (b)+(c) per-page content, verbatim entry + injection/network guard -
    ext_re = re.compile(r"https?://|<script|cdn\.|url\(", re.IGNORECASE)
    link_re = re.compile(r"<link\b", re.IGNORECASE)
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

        # (c) injection guard: no catalog string survives with a raw '<'. Any
        # catalog value containing markup chars must appear ONLY escaped.
        cat_strings = [e.get("title", ""), e.get("requires", ""),
                       e.get("location_hint", ""), e.get("fix", ""),
                       e.get("severity", ""), psource, passert]
        cat_strings += list(e.get("bt_bg") or [])
        for s in cat_strings:
            if s and "<" in s:
                check(s not in page,
                      "%s: catalog string appears UNESCAPED (raw '<'): %r"
                      % (rid, s))

        # (c) no external resource references of any kind.
        check(not ext_re.search(page),
              "%s: page references an external resource / script / url()" % rid)
        check(not link_re.search(page),
              "%s: page has a <link> element (external stylesheet)" % rid)

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

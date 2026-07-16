#!/usr/bin/env python3
"""test_cta.py — every generated per-rule page (``einvoice/www/rules/<ID>/``)
must carry EXACTLY one honest, self-serve CTA block, and every link in it must
resolve to an already-generated target (a real file under ``www/`` or an anchor
id actually present in the target document). No external (http/https) resource
may be introduced by the CTA.

The rule-id set is computed LIVE from ``remediation.load_catalog().keys()`` (the
same source ``test_site.py`` uses), so this test can neither drift from nor
hardcode the catalog size.

Standard library only; no network. Run from the einvoice dir:

    python3 test_cta.py

Checks (each an independent hard assert, across the FULL catalog rule set):

  (a) each ``www/rules/<ID>/index.html`` contains EXACTLY one
      ``<div class="page-cta"> ... </div>`` block (greppable marker).
  (b) that block contains all THREE expected links: the licensing page, the
      in-page German remediation (``--lang de``) anchor, and the landing-page
      quickstart / free on-ramp.
  (c) every internal href in the block resolves — the file part (fragment
      stripped) exists under ``www/``, and any ``#fragment`` names an ``id=``
      that is actually present in the target document (the page itself for a
      pure ``#frag`` href).
  (d) the CTA introduces NO external (http/https) resource.
"""

from __future__ import annotations

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

from einvoice import remediation as _remediation  # noqa: E402

WWW_DIR = os.path.join(HERE, "www")
RULES_DIR = os.path.join(WWW_DIR, "rules")

# The stable, greppable CTA marker. No <div> nests inside the block, so a
# non-greedy match to the first closing </div> captures it exactly.
_CTA_RE = re.compile(r'<div class="page-cta">(.*?)</div>', re.S)
_HREF_RE = re.compile(r'\bhref="([^"]*)"', re.IGNORECASE)
# id="..." (double-quoted, as emitted by gen_site). Used to confirm a fragment
# target actually exists in a document.
_ID_RE = re.compile(r'\bid="([^"]*)"')


def _ids_in(text):
    return set(_ID_RE.findall(text))


def main():
    failures = []

    def check(cond, msg):
        if not cond:
            failures.append(msg)

    catalog = _remediation.load_catalog()
    want = sorted(set(catalog.keys()))
    check(bool(want), "catalog has no rules")

    n_checked = 0
    for rid in want:
        page_path = os.path.join(RULES_DIR, rid, "index.html")
        if not os.path.exists(page_path):
            check(False, "%s: rule page missing (no index.html)" % rid)
            continue
        page = open(page_path, encoding="utf-8").read()
        page_dir = os.path.dirname(page_path)
        page_ids = _ids_in(page)

        # ---- (a) exactly one CTA block ------------------------------------
        marker_count = page.count('class="page-cta"')
        check(marker_count == 1,
              "%s: expected exactly 1 page-cta block, found %d"
              % (rid, marker_count))
        blocks = _CTA_RE.findall(page)
        check(len(blocks) == 1,
              "%s: <div class=\"page-cta\">...</div> not matched exactly once "
              "(got %d)" % (rid, len(blocks)))
        if len(blocks) != 1:
            continue
        block = blocks[0]
        n_checked += 1

        hrefs = _HREF_RE.findall(block)

        # ---- (b) all three expected links present -------------------------
        check(len(hrefs) == 3,
              "%s: CTA block must have exactly 3 links, got %d: %r"
              % (rid, len(hrefs), hrefs))
        has_licensing = any("licensing" in h for h in hrefs)
        has_de = any(h == "#de" or h.endswith("#de") for h in hrefs)
        has_onramp = any(h.endswith("#onramp") for h in hrefs)
        check(has_licensing, "%s: CTA missing the licensing link" % rid)
        check(has_de,
              "%s: CTA missing the in-page German remediation (#de) link" % rid)
        check(has_onramp,
              "%s: CTA missing the quickstart / on-ramp (#onramp) link" % rid)
        # The German link text must reference the --lang de remediation.
        check("--lang de" in block,
              "%s: CTA German link does not reference `--lang de`" % rid)

        # ---- (d) no external resource introduced by the CTA ---------------
        check(not re.search(r"https?://", block, re.IGNORECASE),
              "%s: CTA block introduces an external http(s) resource" % rid)

        # ---- (c) every internal href resolves -----------------------------
        for href in hrefs:
            check(not href.lower().startswith(("http://", "https://")),
                  "%s: CTA href is external: %r" % (rid, href))
            file_part, _, frag = href.partition("#")
            if file_part:
                resolved = os.path.realpath(os.path.join(page_dir, file_part))
                www_root = os.path.realpath(WWW_DIR)
                check(resolved == www_root
                      or resolved.startswith(www_root + os.sep),
                      "%s: CTA href %r escapes www/ (%s)"
                      % (rid, href, resolved))
                check(os.path.exists(resolved),
                      "%s: CTA href %r -> nonexistent file %s"
                      % (rid, href, resolved))
                target_text = (open(resolved, encoding="utf-8").read()
                               if os.path.isfile(resolved) else "")
                target_ids = _ids_in(target_text)
            else:
                # Pure in-page fragment: the target document is THIS page.
                target_ids = page_ids
            if frag:
                check(frag in target_ids,
                      "%s: CTA href %r fragment #%s is not an id in the target "
                      "document" % (rid, href, frag))

    check(n_checked == len(want),
          "CTA checked on %d pages but catalog has %d rules"
          % (n_checked, len(want)))

    if failures:
        sys.stderr.write("CTA TEST: FAIL (%d)\n" % len(failures))
        for m in failures[:40]:
            sys.stderr.write("  !! " + m + "\n")
        return 1
    print("CTA OK: %d rule pages each carry exactly one honest page-cta block "
          "with 3 resolvable internal links (licensing / --lang de German "
          "remediation / quickstart on-ramp); no external resource introduced."
          % n_checked)
    return 0


if __name__ == "__main__":
    sys.exit(main())

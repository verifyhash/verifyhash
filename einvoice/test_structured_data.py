#!/usr/bin/env python3
"""test_structured_data.py — validity guard over the JSON-LD the static site
already emits (``einvoice/www/``).

The per-rule reference pages carry a schema.org JSON-LD block for structured
search results. This test is a *validity* check, not a shape change: it walks
every ``*.html`` under ``www/``, extracts every
``<script type="application/ld+json">...</script>`` block, and ``json.loads()``
each one. It FAILS (exits non-zero) if any block is malformed / unparseable.

To make sure the check cannot pass vacuously (e.g. if extraction silently found
nothing because the tag shape changed), it also asserts that at least one block
was found overall AND that a set of KNOWN rule pages each carry a parseable
block.

Standard library only; no network. Run from the einvoice dir:

    python3 test_structured_data.py
"""

from __future__ import annotations

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WWW_DIR = os.path.join(HERE, "www")

# Matches any <script ... type="application/ld+json" ...> ... </script> block.
# Kept deliberately permissive on the attribute order/spacing so a benign markup
# tweak does not make the guard silently stop finding blocks; the '+' in the
# MIME subtype is escaped. re.S so the JSON body can span lines; IGNORECASE for
# attribute casing.
_LD_RE = re.compile(
    r'<script\b[^>]*\btype="application/ld\+json"[^>]*>(.*?)</script>',
    re.S | re.IGNORECASE,
)

# Known rule pages that MUST carry a parseable JSON-LD block. If any of these is
# missing a block, extraction is broken or the site regressed — the guard must
# not pass. These ids are core EN 16931 / XRechnung rules that always render.
_KNOWN_RULE_PAGES = (
    os.path.join("rules", "BR-01", "index.html"),
    os.path.join("rules", "BR-DE-15", "index.html"),
    os.path.join("rules", "BR-CO-10", "index.html"),
)


def _iter_html_files():
    for root, _dirs, files in os.walk(WWW_DIR):
        for name in sorted(files):
            if name.endswith(".html"):
                yield os.path.join(root, name)


def _blocks_in(path):
    with open(path, encoding="utf-8") as fh:
        return _LD_RE.findall(fh.read())


def main():
    if not os.path.isdir(WWW_DIR):
        print("FAIL: www/ directory not found at %s" % WWW_DIR)
        return 1

    total_blocks = 0
    total_files = 0
    files_with_blocks = 0
    failures = []

    for path in _iter_html_files():
        total_files += 1
        rel = os.path.relpath(path, HERE)
        blocks = _blocks_in(path)
        if blocks:
            files_with_blocks += 1
        for i, raw in enumerate(blocks):
            total_blocks += 1
            try:
                json.loads(raw)
            except Exception as exc:  # noqa: BLE001
                failures.append(
                    "%s: ld+json block #%d does not parse: %s"
                    % (rel, i, exc))

    # (1) every extracted block must have parsed.
    for msg in failures:
        print("FAIL: %s" % msg)

    # (2) non-vacuous: at least one block found overall.
    if total_blocks == 0:
        print("FAIL: no application/ld+json blocks found under www/ — "
              "extraction is broken or the site emits no JSON-LD")

    # (3) non-vacuous: each known rule page carries a parseable block.
    known_ok = True
    for rel in _KNOWN_RULE_PAGES:
        path = os.path.join(WWW_DIR, rel)
        if not os.path.exists(path):
            print("FAIL: known rule page missing: www/%s" % rel)
            known_ok = False
            continue
        blocks = _blocks_in(path)
        if not blocks:
            print("FAIL: known rule page carries no ld+json block: www/%s"
                  % rel)
            known_ok = False
            continue
        for i, raw in enumerate(blocks):
            try:
                json.loads(raw)
            except Exception as exc:  # noqa: BLE001
                print("FAIL: www/%s ld+json block #%d does not parse: %s"
                      % (rel, i, exc))
                known_ok = False

    ok = (not failures) and total_blocks > 0 and known_ok
    print("scanned %d html files under www/; %d carry JSON-LD; "
          "%d application/ld+json blocks found; all parsed: %s"
          % (total_files, files_with_blocks, total_blocks,
             "yes" if ok else "NO"))
    if not ok:
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())

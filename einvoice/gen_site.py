#!/usr/bin/env python3
"""Build the static per-rule reference site (``einvoice/www/rules/``).

For every rule the einvoice engine can fire, this writes ONE self-contained,
offline-openable HTML page at ``einvoice/www/rules/<RULE-ID>/index.html``. Each
page carries that rule's full English remediation-catalog entry: the rule id,
its title, what it requires, the EN 16931 BT/BG business terms it touches, the
XML location hint, the one-line fix, the engine severity, and the Schematron
provenance (source key + the verbatim official assert).

Single source of truth — exactly like ``gen_rules_doc.py``: every per-rule
string is read from ``remediation_catalog.json`` via
:func:`einvoice.remediation.load_catalog`; nothing is authored from memory. The
catalog is fully populated (all fields present for every rule), so there is one
page per rule with NO omission branch: the set of generated page directories is
exactly ``set(einvoice.remediation.load_catalog().keys())``.

Self-containment (hard requirement): every catalog-derived string is escaped
through :func:`html.escape` (quote=True) before it reaches the markup, and the
only styling is one inline ``<style>`` block. There are NO external CSS/JS/CDN
references, no web fonts, no ``<script>``, no ``<img>``, no analytics — each
page opens offline with zero network requests.

Standard library only; no network.

    python3 gen_site.py            # (re)write einvoice/www/rules/<ID>/index.html
    python3 gen_site.py --check    # fail if any committed page is stale/missing/orphan
"""

from __future__ import annotations

import html
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

from einvoice import remediation as _remediation  # noqa: E402

# The generated site tree lives under einvoice/www/rules/<RULE-ID>/index.html.
SITE_DIR = os.path.join(HERE, "www")
RULES_DIR = os.path.join(SITE_DIR, "rules")

# The one and only stylesheet: inline, tiny, no external references.
_STYLE = """
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  line-height: 1.5; margin: 0; padding: 2rem 1rem; color: #1f2328;
  background: #ffffff; }
main { max-width: 46rem; margin: 0 auto; }
.crumb { color: #57606a; font-size: .8rem; text-transform: uppercase;
  letter-spacing: .04em; margin: 0 0 .5rem; }
h1 { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 1.9rem; margin: 0; }
.title { font-size: 1.15rem; margin: .35rem 0 1.5rem; color: #24292f; }
.sev { display: inline-block; font-size: .8rem; font-weight: 700;
  padding: .1rem .5rem; border-radius: .5rem; border: 1px solid #d0d7de; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .55rem 1rem;
  margin: 0; }
dt { font-weight: 700; color: #57606a; }
dd { margin: 0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: #f6f8fa; padding: .1rem .3rem; border-radius: .3rem;
  font-size: .92em; }
.assert { border-left: 3px solid #d0d7de; padding-left: .8rem; margin: 0;
  color: #24292f; }
.terms code { margin-right: .3rem; }
footer { color: #57606a; font-size: .8rem; margin-top: 2.5rem;
  border-top: 1px solid #d0d7de; padding-top: 1rem; }
@media (prefers-color-scheme: dark) {
  body { color: #e6edf3; background: #0d1117; }
  .title, .assert, dd { color: #e6edf3; }
  .crumb, dt, footer { color: #8b949e; }
  code { background: #161b22; }
  .sev, .assert, footer { border-color: #30363d; }
}
""".strip()


def _h(value):
    """HTML-escape any catalog-derived value for safe markup.

    Wraps :func:`html.escape` (quote=True, so ``"`` and ``'`` are encoded) and
    coerces ``None``/non-strings to a string first, so a missing field renders
    empty rather than raising. EVERY catalog string passes through here — there
    is no raw interpolation of catalog text into the document.
    """
    if value is None:
        return ""
    return html.escape(str(value), quote=True)


def render_page(rule_id, entry):
    """Render ONE rule's full HTML page as a ``str``.

    Pure and deterministic: the output depends only on ``rule_id`` and its
    catalog ``entry`` (no clock, no environment, stable ordering), so
    ``test_site.py`` can regenerate every page in memory and assert byte
    equality with the committed tree.
    """
    title = entry.get("title", "")
    requires = entry.get("requires", "")
    bt_bg = entry.get("bt_bg") or []
    location = entry.get("location_hint", "")
    fix = entry.get("fix", "")
    severity = entry.get("severity", "")
    prov = entry.get("provenance") or {}
    prov_source = prov.get("source", "")
    prov_assert = (prov.get("assert", "") or "")

    if bt_bg:
        terms_html = " ".join("<code>%s</code>" % _h(t) for t in bt_bg)
    else:
        terms_html = "<span>— (no single business term)</span>"

    p = []
    w = p.append
    w("<!doctype html>")
    w('<html lang="en">')
    w("<head>")
    w('<meta charset="utf-8">')
    w('<meta name="viewport" content="width=device-width, initial-scale=1">')
    w('<meta name="robots" content="noindex">')
    w("<title>%s — %s — einvoice rule reference</title>"
      % (_h(rule_id), _h(title)))
    w("<style>%s</style>" % _STYLE)
    w("</head>")
    w("<body>")
    w("<main>")
    w('<p class="crumb">einvoice — EN 16931 / XRechnung rule reference</p>')
    w("<h1>%s</h1>" % _h(rule_id))
    w('<p class="title">%s</p>' % _h(title))
    w("<dl>")
    w("<dt>Requires</dt><dd>%s</dd>" % _h(requires))
    w('<dt>Business terms</dt><dd class="terms">%s</dd>' % terms_html)
    w("<dt>Location</dt><dd><code>%s</code></dd>" % _h(location))
    w("<dt>Fix</dt><dd>%s</dd>" % _h(fix))
    w('<dt>Severity</dt><dd><span class="sev">%s</span></dd>' % _h(severity))
    w("<dt>Provenance source</dt><dd><code>%s</code></dd>" % _h(prov_source))
    w("<dt>Provenance assert</dt><dd><p class=\"assert\">%s</p></dd>"
      % _h(prov_assert))
    w("</dl>")
    w("<footer>")
    w("Rendered verbatim from <code>remediation_catalog.json</code> "
      "(single source of truth); regenerate with <code>gen_site.py</code>. "
      "This page is self-contained and opens offline with no network requests.")
    w("</footer>")
    w("</main>")
    w("</body>")
    w("</html>")
    return "\n".join(p) + "\n"


def render_all(catalog):
    """Map ``rule_id -> rendered HTML`` for the whole catalog (pure)."""
    return {rid: render_page(rid, catalog[rid]) for rid in catalog}


def _page_path(rule_id):
    return os.path.join(RULES_DIR, rule_id, "index.html")


def _committed_rule_dirs():
    """Set of rule-id directory names currently present under www/rules/."""
    if not os.path.isdir(RULES_DIR):
        return set()
    return {d for d in os.listdir(RULES_DIR)
            if os.path.isdir(os.path.join(RULES_DIR, d))}


def check(pages):
    """Staleness gate: return 0 iff the committed tree matches ``pages`` exactly.

    Fails (returns 1, with a diagnostic on stderr) if any expected page is
    missing, if any committed page's bytes differ from a fresh render, or if
    there is an orphan rule directory with no catalog entry.
    """
    want = set(pages)
    have = _committed_rule_dirs()

    missing = sorted(want - have)
    orphan = sorted(have - want)
    stale = []
    for rid in sorted(want & have):
        path = _page_path(rid)
        cur = open(path, encoding="utf-8").read() if os.path.exists(path) else None
        if cur != pages[rid]:
            stale.append(rid)

    if missing or orphan or stale:
        sys.stderr.write("stale site (re-run gen_site.py):\n")
        if missing:
            sys.stderr.write("  missing pages: %s\n" % missing[:10])
        if orphan:
            sys.stderr.write("  orphan dirs:   %s\n" % orphan[:10])
        if stale:
            sys.stderr.write("  drifted pages: %s\n" % stale[:10])
        return 1
    print("site up to date (%d rule pages)" % len(want))
    return 0


def write(pages):
    """(Re)write the whole site tree, pruning orphan rule dirs."""
    os.makedirs(RULES_DIR, exist_ok=True)
    # Prune orphan rule directories so the tree never drifts from the catalog.
    for d in _committed_rule_dirs():
        if d not in pages:
            shutil.rmtree(os.path.join(RULES_DIR, d))
    for rid, text in pages.items():
        d = os.path.join(RULES_DIR, rid)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "index.html"), "w", encoding="utf-8") as fh:
            fh.write(text)
    print("wrote %d rule pages under %s"
          % (len(pages), os.path.relpath(RULES_DIR, HERE)))
    return 0


def main(argv):
    catalog = _remediation.load_catalog()
    pages = render_all(catalog)
    if "--check" in argv:
        return check(pages)
    return write(pages)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

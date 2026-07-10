#!/usr/bin/env python3
"""Build the static per-rule reference site (``einvoice/www/rules/``).

For every rule the einvoice engine can fire, this writes ONE self-contained,
offline-openable HTML page at ``einvoice/www/rules/<RULE-ID>/index.html``. Each
page carries that rule's full English remediation-catalog entry: the rule id,
its title, what it requires, the EN 16931 BT/BG business terms it touches, the
XML location hint, the one-line fix, the engine severity, and the Schematron
provenance (source key + the verbatim official assert).

Each page is ALSO bilingual: the catalog's German ``title_de`` and ``fix_de``
are rendered alongside the English strings, each inside an element carrying the
correct ``lang="de"`` attribute (English stays canonical/primary, German is
additive). The German text is honestly labelled by its ``de_source``: an
official KoSIT assert text ("Amtlicher KoSIT-Text") vs. a clearly-marked
translation of the same BT/BG semantics ("Übersetzung") — a translation is
never presented as the official assert. Because EN and DE share ONE URL, we do
NOT emit ``<link rel=alternate hreflang>`` to nonexistent per-language URLs;
language is marked at the element level with ``lang=`` and the document stays
``lang="en"`` primary.

Per-page SEO metadata is derived from the same single source of truth: a
distinct ``<title>`` and ``<meta name=description>`` per rule, one relative
``<link rel=canonical>`` (root-relative placeholder base — the live origin is
bound at deploy time, VHW.3, so no live domain is hardcoded here), and one
schema.org ``TechArticle`` JSON-LD block built with :func:`json.dumps` (every
``<`` in the serialized JSON is replaced with ``\\u003c`` so it can never break
out of the ``<script>`` element). Pages keep ``robots:noindex`` — the
index/noindex flip is deferred to VHW.3.

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
import json
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
.title { font-size: 1.15rem; margin: .35rem 0 .3rem; color: #24292f; }
.title-de { font-size: 1.05rem; margin: 0 0 .35rem; color: #57606a; }
.prov-de { font-size: .78rem; color: #57606a; margin: 0 0 1.5rem; }
[lang="de"] { }
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
  .crumb, dt, footer, .title-de, .prov-de { color: #8b949e; }
  code { background: #161b22; }
  .sev, .assert, footer { border-color: #30363d; }
}
""".strip()


# Root-relative canonical placeholder base. The site's real absolute origin is
# still human-gated (T-VHW.5 undeployed, deployable:false) and is bound at
# deploy time (VHW.3), so we deliberately do NOT hardcode a live verifyhash.com
# URL here. One stable relative canonical per page, distinct by rule id.
_CANONICAL_BASE = "/rules/"

# Honest, human-visible German-provenance labels keyed by the catalog's
# ``de_source``. 'kosit' => the German is the official KoSIT assert text;
# 'translation' => a clearly-labelled translation of the same BT/BG semantics.
# A translation is NEVER presented as the official assert (constitution §7).
_DE_NOTE = {
    "kosit": ("Deutsche Fassung: Amtlicher KoSIT-Text "
              "(official KoSIT assert text)."),
    "translation": ("Deutsche Fassung: Übersetzung der gleichen "
                    "BT/BG-Semantik (translation — not the official assert)."),
}
# The provenance token each de_source must surface (asserted by the test).
_DE_TOKEN = {"kosit": "Amtlicher KoSIT-Text", "translation": "Übersetzung"}


def _description(rule_id, title, fix):
    """A genuinely-distinct, honest meta description for one rule.

    The rule id leads the string and rule ids are unique, so the description is
    unique per page regardless of any truncation. Derived only from catalog
    fields (no authored marketing copy).
    """
    desc = "%s (EN 16931 / XRechnung rule): %s" % (rule_id, title)
    if fix and fix != title:
        desc += " Fix: " + fix
    # Trim to a sane meta length; the unique rule-id prefix is always preserved.
    return desc[:300].rstrip()


def _jsonld(rule_id, title, title_de, fix, description):
    """Serialize ONE honest schema.org TechArticle block for the rule.

    Built with :func:`json.dumps` so every value is properly JSON-escaped, then
    every ``<`` is replaced with ``\\u003c`` (valid JSON that ``json.loads``
    decodes back to ``<``) so the serialized JSON can never contain a literal
    ``</script>`` that would break out of the enclosing ``<script>`` element.
    ``@context`` is the schema.org namespace IRI — an identifier, not a fetched
    resource, so it does not make the page require the network.
    """
    ld = {
        "@context": "https://schema.org",
        "@type": "TechArticle",
        "headline": "%s — %s" % (rule_id, title),
        "alternativeHeadline": title_de,
        "identifier": rule_id,
        "about": {"@type": "Thing", "name": rule_id},
        "description": description,
        "articleBody": fix or title,
        "inLanguage": ["en", "de"],
        "isPartOf": "einvoice EN 16931 / XRechnung rule reference",
    }
    return json.dumps(ld, ensure_ascii=False).replace("<", "\\u003c")


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
    title_de = entry.get("title_de", "")
    requires = entry.get("requires", "")
    bt_bg = entry.get("bt_bg") or []
    location = entry.get("location_hint", "")
    fix = entry.get("fix", "")
    fix_de = entry.get("fix_de", "")
    de_source = entry.get("de_source", "")
    severity = entry.get("severity", "")
    prov = entry.get("provenance") or {}
    prov_source = prov.get("source", "")
    prov_assert = (prov.get("assert", "") or "")

    de_note = _DE_NOTE.get(de_source, _DE_NOTE["translation"])
    description = _description(rule_id, title, fix)
    canonical = _CANONICAL_BASE + rule_id + "/"
    ld_json = _jsonld(rule_id, title, title_de, fix, description)

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
    w('<meta name="description" content="%s">' % _h(description))
    # Single relative canonical (placeholder base; see _CANONICAL_BASE). EN and
    # DE share this one URL, so no per-language hreflang alternates are emitted.
    w('<link rel="canonical" href="%s">' % _h(canonical))
    w("<style>%s</style>" % _STYLE)
    # One honest schema.org TechArticle block; JSON is dumps-built and its '<'
    # chars are neutralised so it cannot break out of the <script> element.
    w('<script type="application/ld+json">%s</script>' % ld_json)
    w("</head>")
    w("<body>")
    w("<main>")
    w('<p class="crumb">einvoice — EN 16931 / XRechnung rule reference</p>')
    w("<h1>%s</h1>" % _h(rule_id))
    w('<p class="title">%s</p>' % _h(title))
    # German title (additive; English above stays canonical/primary).
    w('<p class="title-de" lang="de">%s</p>' % _h(title_de))
    w('<p class="prov-de">%s</p>' % _h(de_note))
    w("<dl>")
    w("<dt>Requires</dt><dd>%s</dd>" % _h(requires))
    w('<dt>Business terms</dt><dd class="terms">%s</dd>' % terms_html)
    w("<dt>Location</dt><dd><code>%s</code></dd>" % _h(location))
    w("<dt>Fix</dt><dd>%s</dd>" % _h(fix))
    w('<dt>Fix (Deutsch)</dt><dd lang="de">%s</dd>' % _h(fix_de))
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

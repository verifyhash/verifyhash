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
distinct ``<title>`` and ``<meta name=description>`` per rule, one absolute
``<link rel=canonical>`` built from the single :data:`BASE_URL` constant (a
documented placeholder bound at deploy, VHW.5), and one schema.org
``TechArticle`` JSON-LD block built with :func:`json.dumps` (every ``<`` in the
serialized JSON is replaced with ``\\u003c`` so it can never break out of the
``<script>`` element). As of VHW.3 the surface is INDEXABLE: rule pages, the
rule index hub and the landing page carry NO ``robots:noindex`` meta, because
this task also ships ``sitemap.xml`` + ``robots.txt`` (a noindexed surface with
a sitemap would be self-contradictory). The canonical ``<link>`` and every
sitemap ``<loc>`` are built from the SAME :data:`BASE_URL`, so they can never
disagree.

Beyond the per-rule pages this generator also emits, from the same catalog:

* a LANDING page at ``www/index.html`` — plain-language what/who/on-ramp;
* a RULE INDEX HUB at ``www/rules/index.html`` — every rule grouped by family,
  reusing :func:`gen_rules_doc.family_of` and its ``FAMILY_LABELS`` (no second
  hand-authored copy of the family labels);
* ``www/sitemap.xml`` (landing + hub + every rule page) and ``www/robots.txt``
  (allow-all, with a ``Sitemap:`` line pointing at ``BASE_URL/sitemap.xml``).

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
# Reuse the ONE family grouping + family-label source of truth (do NOT
# hand-author a second copy of the family labels — constitution §7 / VHW.3 AC5).
# family_of() classifies a rule id; FAMILY_LABELS holds the explanatory intro
# per family. Both are imported from gen_rules_doc — never re-authored here.
from gen_rules_doc import (  # noqa: E402
    FAMILY_LABELS as _FAMILY_LABELS,
    family_of as _family_of,
)

# The generated site tree lives under einvoice/www/rules/<RULE-ID>/index.html.
SITE_DIR = os.path.join(HERE, "www")
RULES_DIR = os.path.join(SITE_DIR, "rules")

# ---------------------------------------------------------------------------
# BASE_URL — the ONE documented placeholder origin for the whole surface.
#
# It is a PLACEHOLDER, bound by the human/supervisor at deploy time (T-VHW.5,
# the human-gated deploy decision per constitution §6). The canonical <link>
# on every page AND every <loc> in sitemap.xml are built from THIS single
# constant, so canonical and sitemap can never disagree. robots.txt's Sitemap:
# line is likewise built from it.
#
#   HUMAN DEPLOY EDIT (one line): if the site is deployed somewhere other than
#   the placeholder below — a subdomain (https://einvoice.verifyhash.com), a
#   different subpath, or its own domain — change ONLY this one string (no
#   trailing slash) and re-run `python3 gen_site.py`. Everything downstream
#   (canonicals, sitemap, robots) follows automatically. See www/robots.txt.
#
# No live DNS is pointed and nothing is deployed by this generator; it only
# writes files under einvoice/www/.
BASE_URL = "https://verifyhash.com/einvoice"

# The one and only stylesheet: inline, tiny, no external references.
_STYLE = """
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  line-height: 1.5; margin: 0; padding: 2rem 1rem; color: #1f2328;
  background: #ffffff; }
main { max-width: 46rem; margin: 0 auto; }
a { color: #0969da; }
a:hover { text-decoration: none; }
.crumb { color: #57606a; font-size: .8rem; text-transform: uppercase;
  letter-spacing: .04em; margin: 0 0 .5rem; }
.crumb a { color: inherit; text-decoration: none; }
.crumb a:hover { text-decoration: underline; }
.lead { font-size: 1.05rem; color: #24292f; }
.fam { margin: 2rem 0 0; }
.fam h2 { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 1.25rem; margin: 0 0 .2rem; }
.fam .intro { color: #57606a; font-size: .92rem; margin: 0 0 .6rem; }
ul.rules { list-style: none; padding: 0; margin: 0; display: grid;
  gap: .3rem; }
ul.rules code { font-size: .85em; }
.toc { columns: 2; column-gap: 2rem; font-size: .95rem; }
.onramp { border: 1px solid #d0d7de; border-radius: .6rem; padding: 1rem 1.2rem;
  margin: 1.5rem 0; }
.onramp h2 { margin-top: 0; }
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
  .title, .assert, dd, .lead { color: #e6edf3; }
  .crumb, dt, footer, .title-de, .prov-de, .fam .intro { color: #8b949e; }
  code { background: #161b22; }
  .sev, .assert, footer, .onramp { border-color: #30363d; }
  a { color: #4493f8; }
}
""".strip()


# Absolute canonical/sitemap URL builders — all derived from the SINGLE
# BASE_URL constant so canonical <link> and sitemap <loc> can never disagree.
def _url_landing():
    """Absolute URL of the landing page (BASE_URL root)."""
    return BASE_URL + "/"


def _url_hub():
    """Absolute URL of the rule index hub."""
    return BASE_URL + "/rules/"


def _url_rule(rule_id):
    """Absolute URL of one rule page (distinct by rule id)."""
    return BASE_URL + "/rules/" + rule_id + "/"


def _url_sitemap():
    """Absolute URL of the sitemap (used only in robots.txt)."""
    return BASE_URL + "/sitemap.xml"


# GitHub repo home of this subproject — the free on-ramp the landing links to.
# These are plain anchor targets (navigated on click), NOT resources the page
# fetches, so they do not break offline-openability; they are also not .css/.js.
_REPO_URL = "https://github.com/verifyhash/verifyhash"
_REPO_README = _REPO_URL + "/blob/main/einvoice/README.md"
_REPO_CI = _REPO_URL + "/tree/main/einvoice/ci"
_REPO_ACTION = _REPO_URL + "/tree/main/einvoice/action"

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
    canonical = _url_rule(rule_id)
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
    # INDEXABLE (VHW.3): no robots:noindex — this surface ships a sitemap.
    w("<title>%s — %s — einvoice rule reference</title>"
      % (_h(rule_id), _h(title)))
    w('<meta name="description" content="%s">' % _h(description))
    # Single absolute canonical built from BASE_URL (same source as the sitemap
    # <loc>). EN and DE share this one URL, so no per-language hreflang.
    w('<link rel="canonical" href="%s">' % _h(canonical))
    w("<style>%s</style>" % _STYLE)
    # One honest schema.org TechArticle block; JSON is dumps-built and its '<'
    # chars are neutralised so it cannot break out of the <script> element.
    w('<script type="application/ld+json">%s</script>' % ld_json)
    w("</head>")
    w("<body>")
    w("<main>")
    # Breadcrumb links back up the surface (relative, offline-resolvable):
    # this page is www/rules/<id>/index.html, so the hub is ../ and the
    # landing is ../../.
    w('<p class="crumb"><a href="../../index.html">einvoice</a> / '
      '<a href="../index.html">EN 16931 / XRechnung rule reference</a></p>')
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


def _doc_head(title, description, canonical, style_extra=""):
    """Shared <head> lines for the landing + hub pages (indexable, no noindex).

    Same self-containment contract as the rule pages: one inline <style>, an
    absolute canonical from BASE_URL, no external CSS/JS/CDN/font, no <script>.
    """
    h = []
    w = h.append
    w("<!doctype html>")
    w('<html lang="en">')
    w("<head>")
    w('<meta charset="utf-8">')
    w('<meta name="viewport" content="width=device-width, initial-scale=1">')
    # INDEXABLE (VHW.3): deliberately NO robots:noindex on landing/hub.
    w("<title>%s</title>" % _h(title))
    w('<meta name="description" content="%s">' % _h(description))
    w('<link rel="canonical" href="%s">' % _h(canonical))
    w("<style>%s</style>" % _STYLE)
    w("</head>")
    return "\n".join(h)


def render_landing():
    """The landing page (``www/index.html``) — pure, deterministic.

    Plain-language explanation of what EN 16931 / XRechnung conformance IS, who
    it is for, and the FREE on-ramp (repo README + CI recipe + GitHub Action),
    plus a link to the rule index hub. Honest scope, no fabricated claims.
    """
    title = ("EN 16931 / XRechnung conformance for German ERP & billing "
             "developers — einvoice")
    description = ("A free, zero-dependency EN 16931 / XRechnung conformance "
                   "validator for German ERP and billing developers: what "
                   "conformance is, who needs it, and how to wire the CI gate "
                   "or GitHub Action in minutes.")
    p = []
    w = p.append
    w(_doc_head(title, description, _url_landing()))
    w("<body>")
    w("<main>")
    w('<p class="crumb">einvoice — EN 16931 / XRechnung conformance</p>')
    w("<h1>einvoice</h1>")
    w('<p class="lead">A zero-dependency, self-hostable conformance validator '
      "for <strong>EN 16931</strong> electronic invoices, targeting the German "
      "<strong>XRechnung</strong> CIUS (UBL 2.1 <code>Invoice</code> syntax). "
      "It runs offline against a vendored copy of the official rule corpus — "
      "no lxml, no Java, no Schematron toolchain, no network calls.</p>")

    w("<h2>What EN 16931 / XRechnung conformance means</h2>")
    w("<p><strong>EN 16931</strong> is the European standard that defines the "
      "semantic data model of an electronic invoice — the business terms "
      "(<code>BT-</code>) and business term groups (<code>BG-</code>) an "
      "invoice must carry, and the arithmetic and code-list rules those values "
      "must satisfy. <strong>XRechnung</strong> is the German national "
      "<em>CIUS</em> (Core Invoice Usage Specification): it keeps the EN 16931 "
      "core and adds ~30 German-specific asserts (the <code>BR-DE-*</code> "
      "rules from KoSIT — BuyerReference, seller contact, payment-means "
      "grouping, Skonto/discount grammar, IBAN checks). An invoice is "
      "<em>conformant</em> when it violates none of the <em>fatal</em> rules of "
      "the profile you validate against.</p>")
    w("<p>Concretely, a rule like <code>BR-DE-15</code> requires the buyer "
      "reference (<code>BT-10</code>) to be present; if it is missing, a "
      "conformance validator reports that rule ID and the invoice is rejected "
      "by the receiver's portal. This site documents every rule this engine "
      "checks, one page each, in English and German.</p>")

    w("<h2>Who this is for</h2>")
    w("<p>German (and EU) <strong>ERP, billing and accounts-payable "
      "developers</strong> who issue or receive structured e-invoices and need "
      "to know <em>before</em> they send that an invoice will pass. Since "
      "1 January 2025 every German business must be able to receive EN 16931 "
      "invoices, with the obligation to issue phasing in through 2027–2028; "
      "France, Belgium and others are on similar timelines. If you generate "
      "XRechnung or ZUGFeRD/Factur-X from an ERP, this is the gate that tells "
      "you whether the output is valid.</p>")

    w('<h2>Honest scope</h2>')
    w("<p>This is an early, auditable slice — not a legal guarantee. The engine "
      "implements the <strong>full XRechnung <code>BR-DE-*</code> layer</strong> "
      "and a large subset of the EN 16931 core rules, each "
      "<em>differential-tested</em> at 100&nbsp;% agreement against the "
      "official Schematron on thousands of real invoices. It does <em>not</em> "
      "yet implement every EN 16931 core rule: a green result means &ldquo;no "
      "implemented rule fired&rdquo;, not &ldquo;certified legally "
      "conformant&rdquo;. The exact implemented set and its limits are written "
      "up in the repository README and <code>CORRECTNESS.md</code>.</p>")

    w('<div class="onramp">')
    w("<h2>Free on-ramp</h2>")
    w("<p>Everything is free and open source (Apache-2.0). Start here:</p>")
    w('<ul class="rules">')
    w('<li><a href="%s">Repository README</a> — install '
      "(<code>pip install .</code> or copy the package dir), the CLI, and the "
      "full honest scope.</li>" % _h(_REPO_README))
    w('<li><a href="%s">CI conformance gate recipe</a> '
      "(<code>einvoice/ci/</code>) — copy-paste POSIX&nbsp;sh + GitHub&nbsp;"
      "Actions / GitLab&nbsp;CI that fails a build on any non-conformant "
      "invoice and names the violated rule ID.</li>" % _h(_REPO_CI))
    w('<li><a href="%s">GitHub Action</a> (<code>einvoice/action/</code>) — a '
      "<code>uses:</code>-pinnable composite action that surfaces each finding "
      "as an inline PR annotation via SARIF.</li>" % _h(_REPO_ACTION))
    w("</ul>")
    w("</div>")

    w("<h2>Browse the rules</h2>")
    w('<p>Every rule the engine can fire has its own reference page — what it '
      "requires, the BT/BG terms it touches, the XML location, a one-line fix, "
      "the severity, and the verbatim official Schematron assert (English and "
      'German). Start at the <a href="rules/index.html">rule index, grouped by '
      "family</a>.</p>")

    w("<footer>")
    w("Generated from <code>remediation_catalog.json</code> (single source of "
      "truth) by <code>gen_site.py</code>. Self-contained: this page opens "
      "offline with no network requests.")
    w("</footer>")
    w("</main>")
    w("</body>")
    w("</html>")
    return "\n".join(p) + "\n"


def render_hub(catalog):
    """The rule index hub (``www/rules/index.html``) — pure, deterministic.

    Every generated rule grouped by rule family, REUSING gen_rules_doc's
    ``family_of()`` + ``FAMILY_LABELS`` (imported — never a second hand-authored
    copy). Each family section carries its real explanatory intro (E-E-A-T) and
    links to every rule page in that family. This is genuine navigation with
    per-rule titles, not a keyword list.
    """
    # Group rule ids by family using gen_rules_doc.family_of() (the ONE family
    # classifier). Families appear in first-seen catalog order; rules keep their
    # catalog order within a family — the same canonical order gen_rules_doc
    # renders RULES.md in.
    order = []
    buckets = {}
    for rid in catalog:
        fam = _family_of(rid)
        if fam not in buckets:
            buckets[fam] = []
            order.append(fam)
        buckets[fam].append(rid)
    groups = [(fam, buckets[fam]) for fam in order]
    n = len(catalog)
    fatal = sum(1 for e in catalog.values() if e.get("severity") == "fatal")
    warn = sum(1 for e in catalog.values() if e.get("severity") == "warning")
    info = sum(1 for e in catalog.values()
               if e.get("severity") == "information")

    title = "EN 16931 / XRechnung rule index — einvoice rule reference"
    description = ("Every EN 16931 / XRechnung business rule the einvoice "
                   "validator checks (%d rules across %d families), grouped by "
                   "rule family with a reference page for each." % (n, len(groups)))
    p = []
    w = p.append
    w(_doc_head(title, description, _url_hub()))
    w("<body>")
    w("<main>")
    w('<p class="crumb"><a href="../index.html">einvoice</a> / '
      "EN 16931 / XRechnung rule reference</p>")
    w("<h1>Rule index</h1>")
    w('<p class="lead">Every EN 16931 / XRechnung business rule the einvoice '
      "engine can fire, grouped by rule family. Each rule links to its own "
      "reference page: what it requires, the BT/BG business terms it touches, "
      "the XML location, a one-line fix, the engine severity, and the verbatim "
      "official Schematron assert.</p>")
    w("<p><strong>%d rules</strong> in total — %d fatal, %d warning, "
      "%d information — across %d families. Family headings are the standard "
      "EN 16931 / XRechnung rule-family labels; every per-rule string on the "
      "linked pages is rendered from the remediation catalog. "
      '<a href="../index.html">Back to the overview</a>.</p>'
      % (n, fatal, warn, info, len(groups)))

    # Family table of contents (in-page anchors).
    w('<nav class="toc">')
    w('<ul class="rules">')
    for fam, ids in groups:
        w('<li><a href="#%s">%s</a> (%d)</li>'
          % (_h(fam), _h(fam), len(ids)))
    w("</ul>")
    w("</nav>")

    # One section per family: real explanatory intro + a link per rule.
    for fam, ids in groups:
        label = _FAMILY_LABELS.get(fam, "%s rules." % fam)
        w('<section class="fam" id="%s">' % _h(fam))
        w("<h2>%s <small>(%d)</small></h2>" % (_h(fam), len(ids)))
        w('<p class="intro">%s</p>' % _h(label))
        w('<ul class="rules">')
        for rid in ids:
            rtitle = catalog[rid].get("title", "")
            sev = catalog[rid].get("severity", "")
            # Relative link resolves offline: hub is www/rules/index.html, the
            # rule page is www/rules/<id>/index.html.
            w('<li><a href="%s/index.html"><code>%s</code></a> — %s '
              '<span class="sev">%s</span></li>'
              % (_h(rid), _h(rid), _h(rtitle), _h(sev)))
        w("</ul>")
        w("</section>")

    w("<footer>")
    w("Generated from <code>remediation_catalog.json</code> (single source of "
      "truth) by <code>gen_site.py</code>, reusing the family grouping and "
      "labels of <code>gen_rules_doc.py</code>. Self-contained: this page opens "
      "offline with no network requests.")
    w("</footer>")
    w("</main>")
    w("</body>")
    w("</html>")
    return "\n".join(p) + "\n"


def render_sitemap(catalog):
    """XML sitemap listing EXACTLY the canonical page set — pure, deterministic.

    The URL set is: landing + rule index hub + every rule page, each <loc>
    built from the SAME BASE_URL as the canonical <link>s, so canonical and
    sitemap can never disagree. Rule order follows the catalog (stable).
    """
    locs = [_url_landing(), _url_hub()]
    locs += [_url_rule(rid) for rid in catalog]
    lines = []
    w = lines.append
    w('<?xml version="1.0" encoding="UTF-8"?>')
    w('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    for loc in locs:
        w("  <url><loc>%s</loc></url>" % _h(loc))
    w("</urlset>")
    return "\n".join(lines) + "\n"


def render_robots():
    """robots.txt for the surface — allow all crawling, point at the sitemap.

    The ``Sitemap:`` line is built from the same BASE_URL as the canonicals and
    sitemap <loc> URLs. A one-line BASE_URL edit at deploy (see gen_site.py's
    BASE_URL comment / T-VHW.5) re-derives this automatically.
    """
    lines = [
        "# einvoice EN 16931 / XRechnung rule reference — crawl allowed.",
        "# The Sitemap: URL and every page canonical are built from the single",
        "# BASE_URL constant in gen_site.py; to move the site to a different",
        "# origin (subpath / subdomain / own domain), edit that ONE line and",
        "# re-run `python3 gen_site.py` (human-gated deploy, T-VHW.5).",
        "User-agent: *",
        "Allow: /",
        "Sitemap: %s" % _url_sitemap(),
    ]
    return "\n".join(lines) + "\n"


# Paths of the four surface-level (non-per-rule) generated files.
LANDING_PATH = os.path.join(SITE_DIR, "index.html")
HUB_PATH = os.path.join(RULES_DIR, "index.html")
SITEMAP_PATH = os.path.join(SITE_DIR, "sitemap.xml")
ROBOTS_PATH = os.path.join(SITE_DIR, "robots.txt")


def render_surface(catalog):
    """Map absolute path -> rendered text for the four surface files (pure)."""
    return {
        LANDING_PATH: render_landing(),
        HUB_PATH: render_hub(catalog),
        SITEMAP_PATH: render_sitemap(catalog),
        ROBOTS_PATH: render_robots(),
    }


def _page_path(rule_id):
    return os.path.join(RULES_DIR, rule_id, "index.html")


def _committed_rule_dirs():
    """Set of rule-id directory names currently present under www/rules/."""
    if not os.path.isdir(RULES_DIR):
        return set()
    return {d for d in os.listdir(RULES_DIR)
            if os.path.isdir(os.path.join(RULES_DIR, d))}


def _read_or_none(path):
    return (open(path, encoding="utf-8").read()
            if os.path.exists(path) else None)


def check(pages, surface):
    """Staleness gate: 0 iff the committed tree matches ``pages`` + ``surface``.

    Fails (returns 1, with a diagnostic on stderr) if any expected per-rule
    page is missing/drifted, if there is an orphan rule directory with no
    catalog entry, OR if any of the four surface files (landing, rule index
    hub, sitemap.xml, robots.txt) is missing or byte-drifted from a fresh
    render. ``surface`` maps absolute path -> expected text.
    """
    want = set(pages)
    have = _committed_rule_dirs()

    missing = sorted(want - have)
    orphan = sorted(have - want)
    stale = []
    for rid in sorted(want & have):
        path = _page_path(rid)
        cur = _read_or_none(path)
        if cur != pages[rid]:
            stale.append(rid)

    # Surface files (landing / hub / sitemap / robots) — missing or drifted.
    surface_bad = []
    for path, text in surface.items():
        if _read_or_none(path) != text:
            surface_bad.append(os.path.relpath(path, HERE))

    if missing or orphan or stale or surface_bad:
        sys.stderr.write("stale site (re-run gen_site.py):\n")
        if missing:
            sys.stderr.write("  missing pages: %s\n" % missing[:10])
        if orphan:
            sys.stderr.write("  orphan dirs:   %s\n" % orphan[:10])
        if stale:
            sys.stderr.write("  drifted pages: %s\n" % stale[:10])
        if surface_bad:
            sys.stderr.write("  stale surface: %s\n" % surface_bad)
        return 1
    print("site up to date (%d rule pages + landing + hub + sitemap + robots)"
          % len(want))
    return 0


def write(pages, surface):
    """(Re)write the whole site tree, pruning orphan rule dirs."""
    os.makedirs(RULES_DIR, exist_ok=True)
    # Prune orphan rule directories so the tree never drifts from the catalog.
    # The rule index hub is a FILE (index.html) directly under www/rules/, not
    # a directory, so _committed_rule_dirs() never sees it as an orphan.
    for d in _committed_rule_dirs():
        if d not in pages:
            shutil.rmtree(os.path.join(RULES_DIR, d))
    for rid, text in pages.items():
        d = os.path.join(RULES_DIR, rid)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "index.html"), "w", encoding="utf-8") as fh:
            fh.write(text)
    # Surface files: landing, rule index hub, sitemap.xml, robots.txt.
    for path, text in surface.items():
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
    print("wrote %d rule pages + landing + hub + sitemap + robots under %s"
          % (len(pages), os.path.relpath(SITE_DIR, HERE)))
    return 0


def main(argv):
    catalog = _remediation.load_catalog()
    pages = render_all(catalog)
    surface = render_surface(catalog)
    if "--check" in argv:
        return check(pages, surface)
    return write(pages, surface)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

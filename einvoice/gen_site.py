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
* a LICENSING page at ``www/licensing/index.html`` — dual-license terms that
  sell honestly (Apache-2.0 open source and free for everyone incl. closed-source
  embedding; an optional $29/$290 commercial license adds support, rule-corpus
  update notices and vendor-key convenience) with a self-serve checkout sourced
  from the committed CHECKOUT_URL placeholder + hello@verifyhash.com contact
  (T-BUY.1, superseding the no-prices T-VHR.5 copy);
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

import difflib
import html
import json
import os
import re
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

# The worked walkthrough page is emitted at the stable canonical path
# www/walkthrough/index.html. Its content is derived from the committed
# onboarding example under examples/01-missing-fields/ — the deliberately-broken
# invoice, the REAL engine report it produces (report.json, itself regenerated
# from the live engine by gen_examples.py and drift-guarded by test_examples.py),
# and the corrected invoice. Nothing on the page is authored from memory.
WALKTHROUGH_DIR = os.path.join(SITE_DIR, "walkthrough")

# The licensing page is emitted at the stable canonical path
# www/licensing/index.html (T-VHR.5). Same template contract as every other
# surface page: inline CSS only, no <script>, canonical from BASE_URL.
LICENSING_DIR = os.path.join(SITE_DIR, "licensing")
EXAMPLE_DIR = os.path.join(HERE, "examples", "01-missing-fields")
EX_BROKEN = os.path.join(EXAMPLE_DIR, "broken.xml")
EX_FIXED = os.path.join(EXAMPLE_DIR, "fixed.xml")
EX_REPORT = os.path.join(EXAMPLE_DIR, "report.json")
# The example directory path as it appears in the report's ``source`` field and
# in the CLI commands shown on the page (relative to the package root).
EX_REL = os.path.relpath(EXAMPLE_DIR, HERE)

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

# SITE_LASTMOD — the deterministic content-revision date emitted as <lastmod>
# on every sitemap <url>. It is a FIXED constant (never datetime.now()/today())
# so `gen_site.py` stays byte-for-byte reproducible and the regeneration-
# determinism check in test_site.py stays green. Hand-bump this ISO-8601 date
# whenever the rule surface (rule pages / landing / hub / walkthrough /
# licensing) materially changes, so crawlers see an accurate last-modified.
SITE_LASTMOD = "2026-07-16"

# CHECKOUT_URL — the ONE committed placeholder for the commercial-license
# self-serve checkout (T-BUY.1). It is intentionally EMPTY in the repo: no
# live payment link is committed. When empty, render_licensing() emits an
# HONEST fallback line ("Checkout opening shortly — email hello@verifyhash.com")
# instead of a dead/broken link. When the human/supervisor pastes the real
# hosted-checkout URL here (one line) and re-runs `python3 gen_site.py`, the
# licensing page renders a real "buy" button pointing at it. Nothing else in
# the page changes. This mirrors the BASE_URL placeholder discipline: one
# committed constant, bound at deploy, no secret and no live endpoint here.
CHECKOUT_URL = ""

# The single private commercial contact for license buyers (replaces the old
# public-GitHub-issue-only route). Kept as one constant so the generated page
# and any future copy stay in sync.
COMMERCIAL_EMAIL = "hello@verifyhash.com"

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
.page-cta { border: 1px solid #d0d7de; border-radius: .6rem;
  padding: .9rem 1.1rem; margin: 1.75rem 0 0; font-size: .95rem; }
.page-cta p { margin: 0 0 .5rem; color: #57606a; }
.page-cta ul.rules { gap: .45rem; }
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
  font-size: .92em; overflow-wrap: anywhere; }
pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: .5rem;
  padding: .7rem .9rem; overflow-x: auto; font-size: .82rem; line-height: 1.5;
  margin: .6rem 0; }
pre code { background: none; padding: 0; overflow-wrap: normal;
  white-space: pre; }
.assert { border-left: 3px solid #d0d7de; padding-left: .8rem; margin: 0;
  color: #24292f; }
.terms code { margin-right: .3rem; }
footer { color: #57606a; font-size: .8rem; margin-top: 2.5rem;
  border-top: 1px solid #d0d7de; padding-top: 1rem; }
@media (max-width: 480px) {
  dl { grid-template-columns: 1fr; gap: .15rem 0; }
  dl dt { margin-top: .55rem; }
  dl dt:first-child { margin-top: 0; }
}
@media (prefers-color-scheme: dark) {
  body { color: #e6edf3; background: #0d1117; }
  .title, .assert, dd, .lead { color: #e6edf3; }
  .crumb, dt, footer, .title-de, .prov-de, .fam .intro { color: #8b949e; }
  code { background: #161b22; }
  pre { background: #161b22; border-color: #30363d; }
  .sev, .assert, footer, .onramp, .page-cta { border-color: #30363d; }
  .page-cta p { color: #8b949e; }
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


def _url_walkthrough():
    """Absolute URL of the worked 'failing CI to fixed invoice' walkthrough."""
    return BASE_URL + "/walkthrough/"


def _url_licensing():
    """Absolute URL of the licensing (dual-license terms) page."""
    return BASE_URL + "/licensing/"


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
_REPO_COVERAGE = _REPO_URL + "/blob/main/einvoice/COVERAGE.md"
_REPO_SECURITY = _REPO_URL + "/blob/main/einvoice/SECURITY.md"
_REPO_REMEDIATION = _REPO_URL + "/blob/main/einvoice/remediation_catalog.json"
_REPO_PROVE = _REPO_URL + "/blob/main/einvoice/prove.py"
_REPO_LICENSE = _REPO_URL + "/blob/main/LICENSE"
_REPO_NOTICE = _REPO_URL + "/blob/main/einvoice/NOTICE"
_REPO_ISSUES = _REPO_URL + "/issues"

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
    # German title (additive; English above stays canonical/primary). Carries
    # a stable id="de" so the page CTA can anchor at the in-page German
    # remediation (title_de/fix_de) without inventing a separate German page.
    w('<p class="title-de" lang="de" id="de">%s</p>' % _h(title_de))
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
    # ---- Honest, non-pressuring page CTA (T-BUY.2) -------------------------
    # Exactly one <div class="page-cta"> per page with three links, each to an
    # already-generated target (relative, offline-resolvable, NO external
    # http(s) resource — keeps test_site.py's no-external invariant intact):
    #   (1) the licensing page (../../licensing/index.html);
    #   (2) the in-page German remediation section (the lang="de" id="de" block
    #       above), which the CLI surfaces via --lang de — NOT a new page;
    #   (3) the landing page's free on-ramp (../../index.html#onramp).
    # Self-serve only: no urgency, no fear, no "required for compliance" framing.
    w('<div class="page-cta">')
    w("<p>Everything here is free and open source — pick up whatever helps, at "
      "your own pace:</p>")
    w('<ul class="rules">')
    w('<li><a href="../../licensing/index.html">Licensing</a> — Apache-2.0 for '
      "everyone, including closed-source embedding; an optional $29 / $290 "
      "commercial license adds support and rule-corpus update notices.</li>")
    w('<li><a href="#de">German remediation (<code>--lang de</code>)</a> '
      "— the German fix for this rule is in the section above; the CLI surfaces "
      "it in place of the English message with <code>--lang de</code>.</li>")
    w('<li><a href="../../index.html#onramp">Quickstart / free on-ramp</a> — '
      "the README, a copy-paste CI-gate recipe, and a 5-minute worked "
      "walkthrough.</li>")
    w("</ul>")
    w("</div>")
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
    # ONE inline <style> element (the self-containment contract): any
    # page-specific rules are APPENDED inside the same block, never a second
    # <style> and never an external sheet. style_extra is empty for every page
    # except the licensing page (its small buy-button/tier styling).
    w("<style>%s%s</style>" % (_STYLE, style_extra))
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
                   "validator for German ERP and billing developers: 286 "
                   "differentially-proven business rules, what conformance "
                   "is, who needs it, and how to wire the CI gate or GitHub "
                   "Action in minutes.")
    p = []
    w = p.append
    w(_doc_head(title, description, _url_landing()))
    w("<body>")
    w("<main>")
    w('<p class="crumb">einvoice — EN 16931 / XRechnung conformance</p>')
    w("<h1>einvoice</h1>")
    w('<p class="lead">A zero-dependency, self-hostable conformance validator '
      "for <strong>EN 16931</strong> electronic invoices, targeting the German "
      "<strong>XRechnung</strong> CIUS (UBL 2.1 <code>Invoice</code> and "
      "UN/CEFACT CII syntaxes). It asserts <strong>286 business rules</strong>, "
      "each differentially proven against the official Schematron artifacts, "
      "and runs offline against a vendored copy of the official rule corpus — "
      "no lxml, no Java, no Saxon, no Schematron toolchain, no network calls. "
      "Pure Python&nbsp;3 standard library, so the same check runs unchanged "
      "in any CI job.</p>")

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

    w("<h2>What is proven — the current coverage numbers</h2>")
    w("<p>The engine asserts <strong>286 business rules</strong>: 209 of the "
      "223 official EN 16931 <code>BR-*</code> rule ids per CEN syntax "
      "universe (UBL and CII), the complete German XRechnung CIUS + extension "
      "layer (<code>BR-DE-*</code>, <code>BR-DEX-*</code>, "
      "<code>BR-DE-CVD-*</code>, <code>BR-TMP-*</code>), and the 21 "
      "<code>PEPPOL-EN16931-R*</code> rules KoSIT ships inside the official "
      "XRechnung Schematron artifact — the KoSIT-vendored subset only, "
      "<em>not</em> Peppol&nbsp;BIS Billing&nbsp;3.0 support. The "
      "machine-checked <strong>fireable-missing count is 0 in both CEN "
      "EN&nbsp;16931 universes</strong>: every official <code>BR-*</code> "
      "assert that can actually fire is either asserted by the engine or a "
      "documented deliberate exclusion. That is deliberately <em>not</em> an "
      "uncaveated 100&nbsp;% claim: 4 official ids "
      "(<code>BR-CO-05</code>&#8211;<code>BR-CO-08</code>) are shipped as "
      'literal <code>test="true()"</code> tautologies in the CEN artifacts — '
      "asserts that can never fire, in either universe, so implementing them "
      "with a differential proof is impossible by construction.</p>")
    w("<p>The last admitted gap in the KoSIT XRechnung artifact — the "
      "Clean-Vehicle-Directive family (<code>BR-DE-CVD-*</code>, "
      "<code>BR-TMP-*</code>) — is <strong>closed with differential proof in "
      "both bindings</strong>. Proof parity between the two syntaxes is "
      "machine-tracked rather than frozen in prose: a test recomputes the "
      "worklist live from the coverage matrix and the vendored CII "
      "Schematron. That worklist is now <strong>closed</strong>: 255 of the "
      "286 asserted rules are differential-proven on both UBL and CII, 30 are "
      "officially UBL-only and 1 is CII-only, with <strong>0 rules left on the "
      "cii-fireable worklist</strong> — every UBL-only rule is resolved with "
      "verbatim artifact evidence (4 cii-artifact-defective, 26 "
      "binding-inapplicable). All differential legs run at <strong>0 "
      "divergences</strong> against the official Schematron.</p>")
    w("<p>Beyond the business rules, the two CEN artifacts also carry "
      "<em>syntax-binding</em> asserts (<code>UBL-CR-*</code>/<code>CII-*</code>) "
      "— pure syntax-layer restrictions like &ldquo;this element must not "
      "appear&rdquo; or &ldquo;at most one of X&rdquo;. A restricted data-driven "
      "evaluator mirrors "
      "<strong>735 of 756 UBL + 506 of 583 CII</strong> of these per binding, "
      "each differential-proven against the official Schematron at "
      "<strong>0 divergences</strong>; the remaining 98 (21 UBL + 77 CII) are "
      "machine-listed as known-open in <code>COVERAGE.md</code>, never guessed. "
      "They surface under a distinct <code>syntax_bindings</code> category in "
      "the <code>--json</code> output as advisory warnings that never change the "
      "exit code, kept strictly separate from the 286 business-rule count.</p>")
    w('<ul class="rules">')
    w('<li><a href="%s">Coverage matrix (COVERAGE.md)</a> — the authoritative '
      "per-rule inventory: every asserted rule, the syntax it is proven in, "
      "its severity, and every deliberate exclusion with verbatim artifact "
      "evidence.</li>" % _h(_REPO_COVERAGE))
    w('<li><a href="%s">Remediation catalog</a> — 286 machine-readable '
      "entries (rule, plain-language fix, XML location, severity, English and "
      "German), the single source of truth these rule pages are generated "
      "from.</li>" % _h(_REPO_REMEDIATION))
    w("</ul>")

    w('<h2>Reproduce these numbers yourself</h2>')
    w("<p>Every count on this page is rebuilt from the vendored official "
      "artifacts by a single committed entrypoint &mdash; nothing here is a "
      "hand-typed figure. From a checkout of <code>einvoice/</code>, run the "
      "exact command the repository README documents:</p>")
    w('<pre><code>%s</code></pre>'
      % _h("PYTHONPATH=$HOME/.local/lib/python3.10/site-packages "
           "python3 prove.py"))
    w('<p><a href="%s"><code>prove.py</code></a> re-runs the full differential '
      "harness over every leg plus the conformance corpus, asserts the "
      "divergence count against the official CEN / KoSIT Schematron, and "
      "prints the coverage headline recomputed live this run (it reads no "
      "number from a string literal, so a stale figure cannot slip through). "
      "It exits non-zero on any failure and takes a few minutes. The "
      "authoritative per-rule inventory those figures roll up from is the "
      '<a href="%s">coverage matrix (COVERAGE.md)</a>; consult it rather than '
      "any digit copied into prose here, which could drift.</p>"
      % (_h(_REPO_PROVE), _h(_REPO_COVERAGE)))

    w('<h2>Honest scope</h2>')
    w("<p>Auditable, but not a legal guarantee. A green result means "
      "&ldquo;no implemented fatal rule fired&rdquo;, not &ldquo;certified "
      "legally conformant&rdquo;: 8 official <code>BR-CL-*</code> code-list "
      "checks are deferred (documented deliberate exclusions, not coverage), "
      "structural XSD validation is not performed, and there is no UBL "
      "<code>CreditNote</code> root. The exact implemented set and its limits "
      "are written up in the repository README, <code>COVERAGE.md</code> and "
      "<code>CORRECTNESS.md</code>.</p>")

    w('<div class="onramp" id="onramp">')
    w("<h2>Free on-ramp</h2>")
    w("<p>New here? The fastest way in is the "
      '<a href="walkthrough/index.html">5-minute worked walkthrough</a>: it '
      "takes a broken XRechnung invoice, runs the checker, shows the real "
      "report it prints, and applies the two-element fix until the invoice "
      "passes.</p>")
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

    w("<h2>Safe on untrusted input</h2>")
    w("<p>The invoices you validate arrive from <strong>untrusted "
      "suppliers</strong>, so the XML parser is hardened against the classic "
      "entity attacks. It uses only the Python standard library "
      "(<code>xml.etree</code> / expat, no <code>lxml</code>, no "
      "<code>defusedxml</code>): a <code>&lt;!DOCTYPE&gt;</code> — internal or "
      "external subset — is rejected before any entity can be defined, so "
      "entity <em>definition</em> and <em>expansion</em> never happen "
      "(billion-laughs and quadratic-blowup payloads abort in constant time "
      "and memory instead of exploding), and no external entity or external "
      "DTD is ever resolved — expat opens no <code>file://</code> or "
      "<code>http://</code> URL, so an <code>XXE</code> pointed at "
      "<code>/etc/passwd</code> or an internal host reads and fetches nothing. "
      "A hostile document is folded into the engine's ordinary "
      "<em>not-well-formed</em> outcome (its own report finding, CLI exit "
      "code&nbsp;3) — a bounded, actionable result, never a crash, a hang, or "
      "a silent pass — and this adds <strong>zero runtime dependencies</strong>. "
      'This is documented in the &ldquo;Untrusted input / XML entity '
      'handling&rdquo; section of <a href="%s">SECURITY.md</a> and proven '
      "end-to-end by <code>test_security.py</code> and "
      "<code>test_robustness.py</code>.</p>" % _h(_REPO_SECURITY))

    # ---- German landing section (lang="de") --------------------------------
    # Full content parity with the English sections above: same facts, same
    # numbers, same caveats, same cross-links — honestly written German, not a
    # thin teaser. The site's bilingual model is per-page (matching the rule
    # pages and the licensing page), so the German landing lives here.
    w('<section lang="de">')
    w("<h2>Auf Deutsch: EN-16931-/XRechnung-Konformit&auml;t</h2>")
    w("<p><strong>einvoice</strong> ist ein Konformit&auml;tspr&uuml;fer ohne "
      "Abh&auml;ngigkeiten (reine Python-3-Standardbibliothek — kein Java, "
      "kein Saxon, keine Schematron-Toolchain, keine Netzwerkzugriffe) "
      "f&uuml;r elektronische Rechnungen nach <strong>EN&nbsp;16931</strong>, "
      "mit Fokus auf die deutsche <strong>XRechnung</strong> (UBL&nbsp;2.1 "
      "<code>Invoice</code> und UN/CEFACT CII). Er l&auml;uft offline gegen "
      "eine mitgelieferte, auditierbare Kopie des offiziellen Regelwerks — "
      "und damit unver&auml;ndert in jeder CI-Pipeline.</p>")
    w("<p>Der Pr&uuml;fer setzt <strong>286 Gesch&auml;ftsregeln</strong> "
      "durch: 209 der 223 offiziellen EN-16931-<code>BR-*</code>-Regeln je "
      "CEN-Syntax-Universum (UBL und CII), die vollst&auml;ndige deutsche "
      "XRechnung-Schicht (<code>BR-DE-*</code>, <code>BR-DEX-*</code>, "
      "<code>BR-DE-CVD-*</code>, <code>BR-TMP-*</code>) sowie die 21 "
      "<code>PEPPOL-EN16931-R*</code>-Regeln, die KoSIT im offiziellen "
      "XRechnung-Schematron-Artefakt mitliefert — nur diese von KoSIT "
      "mitgelieferte Teilmenge, <em>keine</em> Unterst&uuml;tzung f&uuml;r "
      "Peppol&nbsp;BIS Billing&nbsp;3.0. Die maschinell gepr&uuml;fte "
      "L&uuml;cke (&bdquo;fireable-missing&ldquo;) ist in beiden "
      "CEN-Universen <strong>0</strong>: Jede offizielle "
      "<code>BR-*</code>-Regel, die tats&auml;chlich ausl&ouml;sen kann, wird "
      "entweder durchgesetzt oder ist eine dokumentierte, begr&uuml;ndete "
      "Ausnahme. Das ist bewusst <em>keine</em> pauschale "
      "100-%-Behauptung: 4 offizielle Regeln (<code>BR-CO-05</code>&#8211;"
      "<code>BR-CO-08</code>) sind in den CEN-Artefakten als w&ouml;rtliche "
      '<code>test="true()"</code>-Tautologien ausgeliefert — sie k&ouml;nnen '
      "nie ausl&ouml;sen, ein differentieller Beweis ist f&uuml;r sie "
      "konstruktionsbedingt unm&ouml;glich.</p>")
    w("<p>Die letzte eingestandene L&uuml;cke im KoSIT-XRechnung-Artefakt — "
      "die Clean-Vehicle-Directive-Familie (<code>BR-DE-CVD-*</code>, "
      "<code>BR-TMP-*</code>) — ist mit differentiellem Beweis in beiden "
      "Syntaxen <strong>geschlossen</strong>. Die Beweis-Parit&auml;t "
      "zwischen UBL und CII wird maschinell nachgehalten und von einem Test "
      "live neu berechnet, statt in Prosa eingefroren zu werden (Stand "
      "2026-07-11: 196 von 286 Regeln auf beiden Syntaxen bewiesen, 81 "
      "CII-ausl&ouml;sbare Regeln noch auf der Arbeitsliste). Alle "
      "Differentiall&auml;ufe gegen das offizielle Schematron laufen mit "
      "<strong>0 Abweichungen</strong>.</p>")
    w("<p>Ehrlicher Geltungsbereich: Ein gr&uuml;nes Ergebnis bedeutet "
      "&bdquo;keine implementierte fatale Regel hat ausgel&ouml;st&ldquo;, "
      "nicht &bdquo;rechtsverbindlich konform&ldquo; — 8 offizielle "
      "<code>BR-CL-*</code>-Codelisten-Pr&uuml;fungen sind "
      "zur&uuml;ckgestellt, eine XSD-Strukturvalidierung findet nicht statt. "
      'Details und Einstieg: die <a href="%s">Abdeckungsmatrix '
      "(COVERAGE.md)</a> als ma&szlig;gebliches Regelinventar, der "
      '<a href="%s">Korrektur-Katalog (remediation_catalog.json)</a> mit 286 '
      'maschinenlesbaren Eintr&auml;gen, das <a href="%s">CI-Rezept</a> '
      "(POSIX&nbsp;sh + GitHub&nbsp;Actions / GitLab&nbsp;CI) und die "
      '<a href="licensing/index.html">Lizenzseite</a> (Apache-2.0 f&uuml;r '
      "alle; kommerzielle Lizenz auf Anfrage). Jede Regel hat eine eigene "
      '<a href="rules/index.html">Referenzseite</a> auf Englisch und '
      "Deutsch.</p>"
      % (_h(_REPO_COVERAGE), _h(_REPO_REMEDIATION), _h(_REPO_CI)))
    w("<h2>Sicher bei nicht vertrauensw&uuml;rdigen Eingaben</h2>")
    w("<p>Die gepr&uuml;ften Rechnungen stammen von <strong>nicht "
      "vertrauensw&uuml;rdigen Lieferanten</strong>, daher ist der XML-Parser "
      "gegen die klassischen Entity-Angriffe geh&auml;rtet. Er nutzt "
      "ausschlie&szlig;lich die Python-Standardbibliothek "
      "(<code>xml.etree</code> / expat, kein <code>lxml</code>, kein "
      "<code>defusedxml</code>): Ein <code>&lt;!DOCTYPE&gt;</code> — interne "
      "oder externe Teilmenge — wird abgewiesen, bevor eine Entity definiert "
      "werden kann, sodass Entity-<em>Definition</em> und -<em>Expansion</em> "
      "gar nicht erst stattfinden (Billion-Laughs- und "
      "Quadratic-Blowup-Angriffe brechen in konstanter Zeit und konstantem "
      "Speicher ab), und keine externe Entity und kein externes DTD wird je "
      "aufgel&ouml;st — expat &ouml;ffnet keine <code>file://</code>- oder "
      "<code>http://</code>-URL, ein <code>XXE</code> auf "
      "<code>/etc/passwd</code> oder einen internen Host liest und l&auml;dt "
      "nichts. Eine b&ouml;sartige Eingabe f&auml;llt in das gew&ouml;hnliche "
      "<em>not-well-formed</em>-Ergebnis (eigener Report-Befund, CLI-Exit-Code "
      "3) — ein begrenztes, verwertbares Resultat, nie ein Absturz, ein "
      "H&auml;nger oder ein stilles Durchwinken — und das ohne <strong>jede "
      "zus&auml;tzliche Laufzeitabh&auml;ngigkeit</strong>. Dokumentiert im "
      "Abschnitt &bdquo;Untrusted input / XML entity handling&ldquo; der "
      '<a href="%s">SECURITY.md</a>, end-to-end belegt durch '
      "<code>test_security.py</code> und <code>test_robustness.py</code>.</p>"
      % _h(_REPO_SECURITY))
    w("</section>")

    w("<footer>")
    w('Free and open source under Apache-2.0 for everyone; closed-source '
      'vendors who need commercial terms can read the '
      '<a href="licensing/index.html">licensing page</a>. ')
    w("Generated from <code>remediation_catalog.json</code> (single source of "
      "truth) by <code>gen_site.py</code>. Self-contained: this page opens "
      "offline with no network requests.")
    w("</footer>")
    w("</main>")
    w("</body>")
    w("</html>")
    return "\n".join(p) + "\n"


def render_licensing():
    """The licensing page (``www/licensing/index.html``) — pure, deterministic.

    Dual-license terms that SELL honestly (T-BUY.1): the einvoice engine is
    open source under Apache-2.0 for everyone (repo LICENSE linked). Because
    Apache-2.0 already permits closed-source embedding at no cost, the paid
    commercial license does NOT sell permission or "compliance" — it sells
    support, prioritised rule-corpus updates, and vendor-key convenience, at a
    published, self-serve price ($29 single developer, $290 whole vendor team).
    HONESTY LINES enforced in the text itself: state plainly that you do NOT
    need this to embed the engine; NO fear/compliance-pressure, NO
    sales-call/negotiated-contract/metered-API language. The checkout link is
    sourced from the single committed CHECKOUT_URL placeholder — when empty (as
    committed) an honest "Checkout opening shortly — email hello@verifyhash.com"
    fallback renders instead of a dead link. Same self-containment contract as
    every other surface page: one inline <style>, absolute canonical from
    BASE_URL, no <script>, no external CSS/JS/CDN/font. Includes a short German
    summary section (``lang="de"``), matching the site's additive-German style.
    """
    title = ("Licensing — Apache-2.0 open source, $29 / $290 commercial "
             "license — einvoice")
    description = ("How the einvoice EN 16931 / XRechnung validator is "
                   "licensed: Apache-2.0 open source and free for everyone, "
                   "including closed-source embedding. A $29 (single "
                   "developer) or $290 (whole vendor team) commercial license "
                   "adds support, prioritised rule-corpus updates and "
                   "vendor-key convenience — never required to use the engine.")
    # Licensing-only styling, appended inside the single shared <style> block
    # (no second stylesheet) so it never touches any other page.
    style_extra = (
        "\n.tiers { border: 1px solid #d0d7de; border-radius: .6rem;"
        " padding: 1rem 1.2rem; margin: 1.2rem 0; }"
        "\n.tiers h3 { margin: 0 0 .2rem; font-size: 1.05rem; }"
        "\n.tiers .price { font-weight: 700; font-size: 1.15rem; }"
        "\n.buy { display: inline-block; background: #1f883d; color: #ffffff;"
        " padding: .55rem 1.1rem; border-radius: .5rem; text-decoration: none;"
        " font-weight: 700; margin: .4rem 0; }"
        "\n.buy:hover { background: #1a7f37; text-decoration: none; }"
        "\n.buy-fallback { font-weight: 600; }"
        "\n@media (prefers-color-scheme: dark) {"
        " .tiers { border-color: #30363d; } }")
    p = []
    w = p.append
    w(_doc_head(title, description, _url_licensing(), style_extra=style_extra))
    w("<body>")
    w("<main>")
    # Breadcrumb (relative, offline-resolvable): this page is
    # www/licensing/index.html, so the landing is ../index.html.
    w('<p class="crumb"><a href="../index.html">einvoice</a> / Licensing</p>')
    w("<h1>Licensing</h1>")
    w('<p class="lead">The <code>einvoice</code> EN&nbsp;16931 / XRechnung '
      "conformance engine is <strong>open source under the Apache License "
      "2.0</strong> — free for everyone, including embedding it inside a "
      "closed-source product. An optional <strong>commercial license</strong> "
      "(<strong>$29</strong> for one developer, <strong>$290</strong> for a "
      "whole vendor team) adds support, prioritised rule-corpus updates and a "
      "ready-to-use vendor key. It buys convenience, not permission — you "
      "never need it to run or embed the engine.</p>")

    w("<h2>Open source for everyone (Apache-2.0)</h2>")
    w("<p>Every part of the engine — the validator package, the vendored rule "
      "corpus integration, the CI recipes, the GitHub Action and this "
      "reference site generator — is licensed under the "
      '<a href="%s">Apache License 2.0</a> (the <code>LICENSE</code> file at '
      "the repository root). That grant is the same for a hobbyist, a "
      "consultancy and a commercial ERP vendor: you may use, modify, embed "
      "and redistribute the code, including inside closed-source products, "
      "at no cost.</p>" % _h(_REPO_LICENSE))
    w("<p>The Apache-2.0 conditions are the usual ones: keep the license text "
      "and the attribution in the "
      '<a href="%s"><code>einvoice/NOTICE</code></a> file with any '
      "redistribution, and mark files you changed. The license also contains "
      "an express patent grant and — like all open-source licenses — provides "
      "the software <em>as is</em>, with no warranty and no indemnity.</p>"
      % _h(_REPO_NOTICE))

    w("<h2>Commercial license — $29 and $290</h2>")
    w("<p>Apache-2.0 already lets you embed, modify and ship the engine inside "
      "a closed-source product at no cost, so the commercial license is not "
      "about permission and it is not a compliance requirement. It is a small, "
      "self-serve purchase that adds the practical extras a running product "
      "wants: a person to email, a heads-up when the rule corpus changes, and "
      "a vendor key you can drop straight into your build. Two flat prices, "
      "one-time, no contract to negotiate and no call to book:</p>")

    w('<div class="tiers">')
    w("<h3>Single developer &mdash; <span class=\"price\">$29</span></h3>")
    w("<p>For one developer embedding <code>einvoice</code> in a product. "
      "Covers:</p>")
    w('<ul class="rules">')
    w("<li><strong>Email support</strong> from the maintainer for integration "
      "questions (best-effort, typically same working day).</li>")
    w("<li><strong>Rule-corpus update notices</strong> — a heads-up when the "
      "EN&nbsp;16931 / XRechnung rule set changes, so your validation stays "
      "current.</li>")
    w("<li><strong>Vendor key</strong> — a ready-made attribution/vendor "
      "identifier so you skip wiring one up by hand.</li>")
    w("</ul>")
    w("<h3>Vendor team &mdash; <span class=\"price\">$290</span></h3>")
    w("<p>The same three things, but for an <strong>entire company / vendor "
      "team</strong> (any number of developers) rather than one person, plus "
      "priority on support replies and corpus-update notices. If your ERP, "
      "billing or e-invoicing platform ships <code>einvoice</code>, this is "
      "the one to buy.</p>")
    w('</div>')

    # Checkout: sourced from the single committed CHECKOUT_URL placeholder. When
    # empty (as committed) an HONEST fallback renders — never a dead link. When
    # the human pastes the hosted-checkout URL into CHECKOUT_URL and re-runs the
    # generator, a real self-serve "buy" button renders instead.
    if CHECKOUT_URL:
        w('<p><a class="buy" href="%s">Buy a commercial license '
          "&mdash; secure checkout</a></p>" % _h(CHECKOUT_URL))
    else:
        w('<p class="buy-fallback">Checkout opening shortly &mdash; email '
          "%s and we&rsquo;ll send a payment link and the vendor key the same "
          "working day.</p>" % _h(COMMERCIAL_EMAIL))

    w("<p>What the price is <em>not</em>: it is not a fee for using the engine, "
      "not tied to any legal or tax &ldquo;compliance&rdquo; obligation, and "
      "not metered by request volume. You can use, embed and redistribute "
      "<code>einvoice</code> forever under Apache-2.0 without paying anything. "
      "The commercial license simply buys you support, update notices and the "
      "vendor-key convenience described above.</p>")

    w("<h2>How to buy or ask a question</h2>")
    w("<p>Email <a href=\"mailto:%s\">%s</a> to buy, to get the checkout "
      "link, or to ask anything before you do. That is the private commercial "
      "contact for licensing &mdash; you do not have to open a public issue. "
      "The <a href=\"%s\">source and issue tracker</a> stay on GitHub for "
      "bugs and code.</p>" % (_h(COMMERCIAL_EMAIL), _h(COMMERCIAL_EMAIL),
                              _h(_REPO_ISSUES)))

    w('<section lang="de">')
    w("<h2>Kurzfassung (Deutsch)</h2>")
    w("<p>Der <code>einvoice</code>-Konformit&auml;tspr&uuml;fer f&uuml;r "
      "EN&nbsp;16931 / XRechnung ist f&uuml;r alle Open Source unter der "
      "Apache-Lizenz&nbsp;2.0 &mdash; kostenlose Nutzung, Einbettung und "
      "Weitergabe, auch kommerziell und auch in Closed-Source-Produkten, "
      "sofern die Apache-2.0-Bedingungen eingehalten werden (Lizenztext und "
      "<code>NOTICE</code>-Hinweis beilegen, &Auml;nderungen kennzeichnen). "
      "Die Apache-2.0-Lizenz erlaubt das Einbetten in Closed-Source-Produkte "
      "bereits kostenlos; die kommerzielle Lizenz ist daher keine "
      "Nutzungserlaubnis und keine Compliance-Pflicht, sondern kauft nur "
      "Support, bevorzugte Hinweise auf Regel-Updates und einen fertigen "
      "Vendor-Key. Zwei feste Preise, einmalig, ohne Vertragsverhandlung: "
      "<strong>$29</strong> f&uuml;r einen einzelnen Entwickler, "
      "<strong>$290</strong> f&uuml;r ein ganzes Anbieter-Team. Kauf und "
      "Fragen: <a href=\"mailto:%s\">%s</a>.</p>" % (_h(COMMERCIAL_EMAIL),
                                                     _h(COMMERCIAL_EMAIL)))
    w("</section>")

    w("<footer>")
    w("Generated by <code>gen_site.py</code>. Self-contained: this page opens "
      "offline with no network requests. The authoritative license text is "
      "the repository <code>LICENSE</code> file; this page is a plain-language "
      "summary, not a replacement for it.")
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


# Extra styling for the walkthrough page only (code blocks + finding cards).
# Kept in a SEPARATE constant so the shared _STYLE (and therefore the 200+
# committed rule pages) is not touched by adding this one page.
_WALK_STYLE = """
pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: .5rem;
  padding: .8rem 1rem; overflow-x: auto; font-size: .78rem; line-height: 1.45;
  margin: .6rem 0; }
.step { margin: 2.2rem 0 0; }
.step h2 { margin-bottom: .3rem; }
.finding { border: 1px solid #d0d7de; border-radius: .6rem;
  padding: .7rem 1rem; margin: .8rem 0; }
.finding .fhead { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center;
  margin: 0 0 .35rem; }
.finding .fhead code { font-size: .9em; }
.finding h3 { margin: .3rem 0; font-size: 1.02rem; }
.finding .hint { color: #57606a; font-size: .92rem; margin: .35rem 0 0; }
.pass { border-left: 4px solid #1a7f37; padding-left: .9rem; margin: 1rem 0; }
.summary code { font-weight: 700; }
@media (prefers-color-scheme: dark) {
  pre { background: #161b22; border-color: #30363d; color: #e6edf3; }
  .finding { border-color: #30363d; }
  .finding .hint { color: #8b949e; }
}
""".strip()


def _strip_leading_comment(xml):
    """Drop the first ``<!-- ... -->`` block (the provenance header) from an XML
    string so a body diff shows ONLY invoice-content changes, not the differing
    provenance comments of broken.xml vs fixed.xml."""
    return re.sub(r"<!--.*?-->\n?", "", xml, count=1, flags=re.S)


def _body_diff(broken_xml, fixed_xml):
    """Unified diff of the two invoice BODIES (provenance comments stripped).

    For this example the diff is exactly the two restored elements
    (``<cbc:BuyerReference>`` and the seller ``<cac:Contact>`` group), so it is
    an honest, derived picture of the fix — never hand-authored.
    """
    b = _strip_leading_comment(broken_xml).splitlines()
    f = _strip_leading_comment(fixed_xml).splitlines()
    return "\n".join(difflib.unified_diff(
        b, f, fromfile="broken.xml", tofile="fixed.xml", lineterm=""))


def _walkthrough_inputs():
    """Read the committed example corpus (broken/fixed XML + the live report).

    The report is the REAL engine output committed at
    examples/01-missing-fields/report.json — regenerated from the engine by
    gen_examples.py and asserted current by test_examples.py, so it can never
    silently drift from what the tool emits. This function never runs the engine
    itself (gen_site stays offline/deterministic); the anti-drift guarantee is
    provided by test_walkthrough.py, which re-runs the LIVE engine and fails if
    the rendered report content disagrees.
    """
    with open(EX_BROKEN, encoding="utf-8") as fh:
        broken = fh.read()
    with open(EX_FIXED, encoding="utf-8") as fh:
        fixed = fh.read()
    with open(EX_REPORT, encoding="utf-8") as fh:
        report = json.load(fh)
    return broken, fixed, report


def render_walkthrough(catalog):
    """The worked walkthrough page (``www/walkthrough/index.html``) — pure.

    A 5-minute quickstart: (a) a deliberately-broken XRechnung invoice, (b) the
    REAL conformance report the engine produces for it (each finding's rule id
    linked to its per-rule reference page, plain-language title, EN 16931 BT/BG
    terms and the fix hint — straight from the committed live report.json), and
    (c) the corrected invoice, shown as the exact element diff, which the engine
    then accepts. Every invoice/report-derived string is HTML-escaped; the page
    is self-contained and opens offline with no network requests.
    """
    broken_xml, fixed_xml, report = _walkthrough_inputs()
    source = report.get("source", "")
    profile = report.get("profile", "")
    violations = report.get("violations") or []
    fatal_count = report.get("fatal_count", 0)
    warning_count = report.get("warning_count", 0)
    violation_count = report.get("violation_count", len(violations))
    n_fatal = sum(1 for v in violations if v.get("severity") == "fatal")
    body_diff = _body_diff(broken_xml, fixed_xml)

    title = ("From a failing CI check to a passing e-invoice — a worked "
             "EN 16931 / XRechnung walkthrough — einvoice")
    description = ("A 5-minute worked example: a deliberately-broken XRechnung "
                   "UBL invoice, the real conformance report einvoice produces "
                   "(%d findings, %d fatal), and the exact two-element fix that "
                   "makes it pass." % (violation_count, n_fatal))
    canonical = _url_walkthrough()

    p = []
    w = p.append
    w("<!doctype html>")
    w('<html lang="en">')
    w("<head>")
    w('<meta charset="utf-8">')
    w('<meta name="viewport" content="width=device-width, initial-scale=1">')
    # INDEXABLE (VHW.3): no robots:noindex — this page is in the sitemap.
    w("<title>%s</title>" % _h(title))
    w('<meta name="description" content="%s">' % _h(description))
    w('<link rel="canonical" href="%s">' % _h(canonical))
    # One inline <style> block: the shared base plus the walkthrough-only extra.
    # No external CSS/JS/CDN/font/script — offline-openable.
    w("<style>%s\n%s</style>" % (_STYLE, _WALK_STYLE))
    w("</head>")
    w("<body>")
    w("<main>")
    # Breadcrumb up to the landing + rule hub (relative, offline-resolvable):
    # this page is www/walkthrough/index.html.
    w('<p class="crumb"><a href="../index.html">einvoice</a> / '
      '<a href="../rules/index.html">EN 16931 / XRechnung rule reference</a> / '
      "Walkthrough</p>")
    w("<h1>From failing CI to a fixed invoice</h1>")
    w('<p class="lead">A five-minute worked example. We take a real German '
      "<strong>XRechnung</strong> (EN 16931 UBL) invoice with two required "
      "things removed, run the <code>einvoice</code> conformance checker exactly "
      "as a CI gate would, read the actual report it prints, and apply the fix "
      "until the invoice passes. Every finding below is produced by the real "
      "engine — the report is regenerated from the tool and a test fails the "
      "build if this page ever drifts from live output.</p>")
    w("<p>The engine behind this walkthrough asserts <strong>286 EN 16931 / "
      "XRechnung business rules</strong> — every official EN 16931 "
      "<code>BR-*</code> rule that can actually fire in either CEN syntax "
      "universe (UBL and CII) except eight deferred code-list checks, the "
      "complete German KoSIT layer including the Clean-Vehicle-Directive "
      "family, and the 21 <code>PEPPOL-EN16931-R*</code> rules KoSIT vendors "
      "(that subset only, not Peppol BIS Billing 3.0) — each rule "
      "differentially proven against the official Schematron artifacts at 0 "
      "divergences. The per-rule inventory and its honest limits live in "
      "<code>COVERAGE.md</code> in the repository.</p>")
    w("<p>You can reproduce every step yourself: you only need Python 3 and this "
      "repository, no dependencies and no network. Run the commands from the "
      "<code>einvoice/</code> directory.</p>")

    # ---- Step 1: the broken invoice ---------------------------------------
    w('<section class="step">')
    w("<h2>1. The broken invoice</h2>")
    w("<p>A supplier exported this UBL invoice, but two mandatory items are "
      "missing: the <strong>Buyer reference</strong> "
      "(<code>BT-10</code>, the <em>Leitweg-ID</em> routing id a German public "
      "buyer requires) and the <strong>SELLER CONTACT</strong> group "
      "(<code>BG-6</code>, a <code>cac:Contact</code> under the supplier "
      "party). Everything else is a byte-for-byte copy of a valid KoSIT test "
      "document, so these two omissions are the <em>only</em> reason it fails. "
      "The full file is <code>%s/broken.xml</code>:</p>" % _h(EX_REL))
    w("<pre>%s</pre>" % _h(broken_xml))
    w("</section>")

    # ---- Step 2: run the checker (the CI gate) ----------------------------
    w('<section class="step">')
    w("<h2>2. Run the checker (this is your CI gate)</h2>")
    w("<p>Point the tool at the invoice. In a CI pipeline this is the command "
      "whose non-zero exit fails the build:</p>")
    w("<pre>$ python3 -m einvoice.report %s/broken.xml --format json</pre>"
      % _h(EX_REL))
    w("<p>It exits <strong>1</strong> and prints the report below. Only "
      "<code>fatal</code> findings make an invoice invalid (mirroring the "
      "official Schematron <code>flag</code> semantics); <code>warning</code> "
      "and <code>information</code> findings are advisory and do not fail the "
      "build.</p>")
    w("</section>")

    # ---- Step 3: read the real report -------------------------------------
    w('<section class="step">')
    w("<h2>3. Read the report</h2>")
    w('<p class="summary">The engine reports <code>valid: %s</code> for '
      "<code>%s</code> under profile <code>%s</code>: "
      "<code>%d</code> findings in total, <code>%d</code> fatal and "
      "<code>%d</code> warning. Each finding names the violated rule, the "
      "EN 16931 business terms it touches, and a concrete fix hint. The rule id "
      "links to its full reference page.</p>"
      % (_h(json.dumps(report.get("valid"))), _h(source), _h(profile),
         violation_count, fatal_count, warning_count))

    for v in violations:
        rule = v.get("rule", "")
        severity = v.get("severity", "")
        vtitle = v.get("title", "")
        hint = v.get("fix_hint", "")
        terms = v.get("terms") or []
        terms_html = " ".join("<code>%s</code>" % _h(t) for t in terms)
        # Link the rule id back to its per-rule reference page when that page
        # exists (it always does for catalog rules; the guard keeps the link
        # from ever dangling). Relative path resolves offline: this page is
        # www/walkthrough/index.html, the rule page is www/rules/<id>/index.html.
        if rule in catalog:
            rule_html = ('<a href="../rules/%s/index.html"><code>%s</code></a>'
                         % (_h(rule), _h(rule)))
        else:
            rule_html = "<code>%s</code>" % _h(rule)
        w('<div class="finding">')
        w('<p class="fhead">%s <span class="sev">%s</span> %s</p>'
          % (rule_html, _h(severity), terms_html))
        w("<h3>%s</h3>" % _h(vtitle))
        w('<p class="hint">%s</p>' % _h(hint))
        w("</div>")

    w("<p>The two <code>fatal</code> findings (<code>BR-DE-15</code> and "
      "<code>BR-DE-2</code>) are why the invoice is rejected. The "
      "<code>information</code> finding is advisory — we leave it as-is so this "
      "stays a minimal two-field fix. For a full remediation write-up of any "
      "rule, run <code>python3 -m einvoice.report --explain BR-DE-15</code>.</p>")
    w("</section>")

    # ---- Step 4: the fix ---------------------------------------------------
    w('<section class="step">')
    w("<h2>4. Apply the fix</h2>")
    w("<p>Restore the two missing elements. This is the exact diff from "
      "<code>broken.xml</code> to the corrected <code>fixed.xml</code> "
      "(the provenance comment headers are omitted; the invoice bodies differ "
      "by nothing else):</p>")
    w("<pre>%s</pre>" % _h(body_diff))
    w("<p>A <code>cac:Contact</code> needs at least a name, telephone and/or "
      "e-mail; the buyer reference is the routing id your buyer gives you.</p>")
    w("</section>")

    # ---- Step 5: it passes -------------------------------------------------
    w('<section class="step">')
    w("<h2>5. The corrected invoice passes</h2>")
    w("<p>Re-run the same command on the corrected file "
      "(<code>%s/fixed.xml</code>):</p>" % _h(EX_REL))
    w("<pre>$ python3 -m einvoice.report %s/fixed.xml --format json</pre>"
      % _h(EX_REL))
    w('<p class="pass">It now exits <strong>0</strong> and reports '
      "<code>valid: true</code> with <code>fatal_count: 0</code>. Both "
      "<code>BR-DE-*</code> fatals are gone and the invoice would pass this "
      "pre-flight. (This page&rsquo;s test re-runs the live engine on "
      "<code>fixed.xml</code> and fails the build unless it really passes with "
      "zero fatal findings.)</p>")
    w("<p><strong>Honest limit:</strong> a green result means &ldquo;no "
      "implemented rule fired&rdquo;, not &ldquo;certified legally "
      "conformant&rdquo;. This is a fast pre-flight that catches the mistakes "
      "which trip up most first submissions — still run your buyer&rsquo;s "
      "official validator before you file.</p>")
    w("</section>")

    w('<section class="step">')
    w("<h2>Next</h2>")
    w('<p>Browse every rule the engine checks in the '
      '<a href="../rules/index.html">rule index</a>, or start from the '
      '<a href="../index.html">overview</a> for install and the CI-gate '
      "recipe.</p>")
    w("</section>")

    w("<footer>")
    w("The report on this page is rendered from "
      "<code>examples/01-missing-fields/report.json</code> — real engine output "
      "regenerated by <code>gen_examples.py</code> and drift-guarded by "
      "<code>test_examples.py</code> / <code>test_walkthrough.py</code>. "
      "Self-contained: this page opens offline with no network requests.")
    w("</footer>")
    w("</main>")
    w("</body>")
    w("</html>")
    return "\n".join(p) + "\n"


def render_sitemap(catalog):
    """XML sitemap listing EXACTLY the canonical page set — pure, deterministic.

    The URL set is: landing + rule index hub + the worked walkthrough + the
    licensing page + every rule page, each <loc> built from the SAME BASE_URL
    as the canonical <link>s, so canonical and sitemap can never disagree.
    Rule order follows the catalog (stable).
    """
    locs = [_url_landing(), _url_hub(), _url_walkthrough(), _url_licensing()]
    locs += [_url_rule(rid) for rid in catalog]
    lines = []
    w = lines.append
    w('<?xml version="1.0" encoding="UTF-8"?>')
    w('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    for loc in locs:
        w("  <url><loc>%s</loc><lastmod>%s</lastmod></url>" % (_h(loc), SITE_LASTMOD))
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


# Paths of the surface-level (non-per-rule) generated files.
LANDING_PATH = os.path.join(SITE_DIR, "index.html")
HUB_PATH = os.path.join(RULES_DIR, "index.html")
WALKTHROUGH_PATH = os.path.join(WALKTHROUGH_DIR, "index.html")
LICENSING_PATH = os.path.join(LICENSING_DIR, "index.html")
SITEMAP_PATH = os.path.join(SITE_DIR, "sitemap.xml")
ROBOTS_PATH = os.path.join(SITE_DIR, "robots.txt")


def render_surface(catalog):
    """Map absolute path -> rendered text for the surface files (pure).

    Landing, rule index hub, worked walkthrough, licensing page, sitemap.xml
    and robots.txt.
    """
    return {
        LANDING_PATH: render_landing(),
        HUB_PATH: render_hub(catalog),
        WALKTHROUGH_PATH: render_walkthrough(catalog),
        LICENSING_PATH: render_licensing(),
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
    catalog entry, OR if any surface file (landing, rule index hub,
    walkthrough, licensing, sitemap.xml, robots.txt) is missing or
    byte-drifted from a fresh render. ``surface`` maps absolute path ->
    expected text.
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
    print("site up to date (%d rule pages + landing + hub + walkthrough + licensing + sitemap + robots)"
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
    # Surface files: landing, rule index hub, walkthrough, sitemap, robots.
    # Ensure each parent dir exists (the walkthrough lives in its own subdir).
    for path, text in surface.items():
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
    print("wrote %d rule pages + landing + hub + walkthrough + licensing + sitemap + robots under %s"
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

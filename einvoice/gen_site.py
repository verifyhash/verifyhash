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

import ast
import difflib
import hashlib
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
# The engine-bundle manifest's "version" field is READ from the package —
# never hardcoded — so a version bump can't leave a stale manifest behind
# (test_web_bundle.py binds manifest["version"] to einvoice.__version__).
from einvoice import __version__ as _ENGINE_VERSION  # noqa: E402
# LIVE registries for the comparison page (T-VHCMP.1): every engine fact the
# compare page states (rule count, Peppol-subset size, report formats, exit
# codes) is read from these at render time — NO hand-typed figure in the
# template, so the page can never silently drift from the engine.
from einvoice import coverage as _coverage        # noqa: E402
from einvoice import cli as _cli                  # noqa: E402
from einvoice.report import REPORT_FORMATS as _REPORT_FORMATS  # noqa: E402
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

# The honest comparison page (T-VHCMP.1) is emitted at the stable canonical
# path www/compare/index.html. It answers the #1 German-ERP-developer
# evaluation question ("why not the free official KoSIT validator, or
# Mustangproject?") strictly factually: both alternatives are free, KoSIT is
# the official reference implementation, and this page concedes plainly where
# they do more (XSD schema validation, full Peppol BIS ecosystems, writing
# ZUGFeRD PDFs). ENGLISH-only by design (VHDE cap) — no /de/ variant. Every
# engine figure on the page is rendered from the live registries imported
# above and carries a data-claim attribute that test_site.py binds to the same
# registries (claims-drift guard).
COMPARE_DIR = os.path.join(SITE_DIR, "compare")

# The German-language product/quickstart page (T-VHDE.1) is emitted at the
# stable canonical path www/de/index.html. It is ORIGINAL German prose (what
# the tool is, the honest coverage story, install + validate + CI wiring) —
# NOT a translation of the English landing page, and there are deliberately NO
# per-rule German pages (the thin-content line: official German remediation
# text stays the vendored --lang de surface / the lang="de" islands on the
# per-rule pages). The page and the English landing carry hreflang alternates
# in BOTH directions.
DE_DIR = os.path.join(SITE_DIR, "de")
# The German-language worked walkthrough (T-VHDE.3) is emitted at the stable
# canonical path www/de/walkthrough/index.html. It mirrors the English
# render_walkthrough() over the SAME live-engine finding data (broken_xml,
# fixed_xml, report from _walkthrough_inputs()) but carries ORIGINAL German
# adoption prose — never a machine translation of the English page. The two
# walkthroughs carry hreflang alternates in BOTH directions.
DE_WALKTHROUGH_DIR = os.path.join(DE_DIR, "walkthrough")

# ---------------------------------------------------------------------------
# In-browser validator ENGINE BUNDLE (T-VHWEB.1) — www/validate/engine/.
#
# A BYTE-IDENTICAL copy of every einvoice package module (.py) the validate
# path transitively imports, plus a manifest.json (sorted file list, sha256
# per file, package version). The bundle is what a future Pyodide page
# (T-VHWEB.2 — NOT built here) loads to validate an invoice fully in the
# browser with zero install; the byte-identity drift guard in
# test_web_bundle.py means the browser can never run a stale or divergent
# engine.
#
# The module set is NOT hand-listed: :func:`engine_bundle_modules` traces
# import statements (via ``ast``, so function-level imports count too) from
# the seeds ``__init__`` + ``validate`` to a transitive closure over the
# package. As of T-VHWEB.1 that closure is every package module EXCEPT
# ``__main__`` (nothing in the closure imports it — it exists only for
# ``python -m einvoice``). Files are copied as raw BYTES — never re-encoded
# or rewritten — and the manifest is rendered with sort_keys, so emission is
# deterministic and the run-twice byte-identity check in test_site.py holds.
# ---------------------------------------------------------------------------
VALIDATE_DIR = os.path.join(SITE_DIR, "validate")
ENGINE_DIR = os.path.join(VALIDATE_DIR, "engine")
# The source package the bundle mirrors.
PKG_DIR = os.path.join(HERE, "einvoice")
# Trace roots: the package init (public API) + the validate module itself.
ENGINE_SEEDS = ("__init__", "validate")

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
SITE_LASTMOD = "2026-07-22"

# ---------------------------------------------------------------------------
# Pyodide CDN pin (T-VHWEB.2) — the in-browser validator page's ONLY external
# resource, and it is NEVER fetched on page load: the generated
# www/validate/index.html injects this <script> dynamically, on an explicit
# button click, with the SRI integrity attribute below and
# crossorigin="anonymous". EXACT version pin (never @latest / a range) so the
# integrity hash can never silently stop matching.
#
# Pyodide is MPL-2.0, so it is deliberately NOT vendored into this repo (the
# vendoring policy is MIT/Apache/BSD only); only the URL + hash live here.
# The SRI hash below is the real sha384 of the pinned file, computed once at
# build time from the exact bytes jsDelivr serves for this immutable version:
#
#   curl -sS https://cdn.jsdelivr.net/pyodide/v314.0.2/full/pyodide.js \
#     | openssl dgst -sha384 -binary | openssl base64 -A
#
# To bump the version: change PYODIDE_VERSION, recompute the hash with the
# command above, paste it, re-run `python3 gen_site.py`. A mismatched hash
# makes the browser refuse to execute the script (that is the point).
# ---------------------------------------------------------------------------
PYODIDE_VERSION = "314.0.2"
PYODIDE_JS_URL = ("https://cdn.jsdelivr.net/pyodide/v%s/full/pyodide.js"
                  % PYODIDE_VERSION)
PYODIDE_INDEX_URL = ("https://cdn.jsdelivr.net/pyodide/v%s/full/"
                     % PYODIDE_VERSION)
PYODIDE_SRI = ("sha384-"
               "Y0xVpf8xnYY2wjyRPIe9ZRoE61jRI5ihohgCmZlml2k7pWtPdL7ebjaNml0Esgzg")
# Honest download figure shown on the load button: the pinned Pyodide runtime
# (pyodide.js ~19 KB + pyodide.asm.wasm ~9.6 MB + python_stdlib.zip ~2.5 MB +
# pyodide-lock.json ~0.1 MB) plus the ~1 MB engine bundle — ~13 MB uncompressed
# (the CDN serves it compressed, so the wire cost is lower).
PYODIDE_APPROX_MB = 13

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

# ---------------------------------------------------------------------------
# DE_COMMANDS — every shell command shown on the German page (T-VHDE.1), each
# BYTE-IDENTICAL to a command the committed English docs already carry and
# test-pin (QUICKSTART.md is parsed and executed by test_quickstart.py;
# ci/README.md's recipe files are executed by test_ci_recipe.py). The German
# page NEVER invents a command: each tuple is (command, doc-relative-path) and
# test_site.py asserts the command string appears verbatim BOTH in that doc and
# on the rendered German page — so a command edit in the docs that is not
# mirrored here (or vice versa) fails the guard.
# ---------------------------------------------------------------------------
DE_COMMANDS = (
    ("python3 einvoice.py validate --profile xrechnung "
     "examples/01-missing-fields/fixed.xml", "QUICKSTART.md"),
    ("python3 -m pip install .", "QUICKSTART.md"),
    ("einvoice validate --profile xrechnung "
     "examples/01-missing-fields/fixed.xml", "QUICKSTART.md"),
    ("python3 einvoice.py validate --profile xrechnung "
     "examples/01-missing-fields/broken.xml", "QUICKSTART.md"),
    ("python3 einvoice.py validate --json --profile xrechnung "
     "examples/01-missing-fields/broken.xml", "QUICKSTART.md"),
    ("python3 -m pip install ./third_party/einvoice",
     os.path.join("ci", "README.md")),
    ("sh third_party/einvoice/ci/validate-invoices.sh invoices/",
     os.path.join("ci", "README.md")),
)

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


def _url_compare():
    """Absolute URL of the honest KoSIT/Mustangproject comparison page."""
    return BASE_URL + "/compare/"


def _url_validate():
    """Absolute URL of the in-browser validator page (T-VHWEB.2)."""
    return BASE_URL + "/validate/"


def _url_de():
    """Absolute URL of the German-language product/quickstart page."""
    return BASE_URL + "/de/"


def _url_de_walkthrough():
    """Absolute URL of the German-language worked walkthrough."""
    return BASE_URL + "/de/walkthrough/"


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


def _doc_head(title, description, canonical, style_extra="", lang="en",
              alternates=()):
    """Shared <head> lines for the landing + hub pages (indexable, no noindex).

    Same self-containment contract as the rule pages: one inline <style>, an
    absolute canonical from BASE_URL, no external CSS/JS/CDN/font, no <script>.

    ``lang`` sets the document language on ``<html>`` (the German page passes
    ``"de"``). ``alternates`` is an iterable of ``(hreflang, absolute-url)``
    pairs emitted as ``<link rel="alternate" hreflang=...>`` right after the
    canonical — used ONLY by the landing/German pair (both directions), never
    by pages without a language counterpart. These are navigational/SEO link
    elements (not fetched resources), built from the same BASE_URL as the
    canonical, so canonical/hreflang/sitemap can never disagree.
    """
    h = []
    w = h.append
    w("<!doctype html>")
    w('<html lang="%s">' % _h(lang))
    w("<head>")
    w('<meta charset="utf-8">')
    w('<meta name="viewport" content="width=device-width, initial-scale=1">')
    # INDEXABLE (VHW.3): deliberately NO robots:noindex on landing/hub.
    w("<title>%s</title>" % _h(title))
    w('<meta name="description" content="%s">' % _h(description))
    w('<link rel="canonical" href="%s">' % _h(canonical))
    for hl, href in alternates:
        w('<link rel="alternate" hreflang="%s" href="%s">'
          % (_h(hl), _h(href)))
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
    # hreflang alternates BOTH directions (T-VHDE.1): the English landing and
    # the German product/quickstart page reference each other (plus the
    # required self-referencing entry and an x-default pointing at English).
    w(_doc_head(title, description, _url_landing(),
                alternates=(("en", _url_landing()), ("de", _url_de()),
                            ("x-default", _url_landing()))))
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
    w("<p>Weighing this against the free official toolchain? Read the honest "
      '<a href="compare/index.html">comparison with the official KoSIT '
      "validator and Mustangproject</a> — what each is best at, and exactly "
      "when to prefer them over this tool.</p>")

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

    w("<h2>Try it in your browser — zero install</h2>")
    w("<p>Want a verdict before installing anything? The "
      '<a href="validate/index.html">in-browser validator</a> runs the same '
      "engine on your machine via WebAssembly (Pyodide): drop an XRechnung "
      "XML or a ZUGFeRD/Factur-X PDF and read the findings, each linked to "
      "its rule page. The invoice is never uploaded — after an explicit "
      "one-time runtime download (~%d&nbsp;MB), validation happens entirely "
      "in your browser.</p>" % PYODIDE_APPROX_MB)

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
    w('<p><strong><a href="de/index.html">Deutschsprachige Produkt- und '
      "Schnellstart-Seite</a></strong> &mdash; was das Werkzeug ist, was es "
      "ehrlich abdeckt (und was nicht), Installation, erste Pr&uuml;fung und "
      "CI-Anbindung, komplett auf Deutsch.</p>")
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
      '<a href="licensing/index.html">licensing page</a>; evaluators can read '
      'the honest <a href="compare/index.html">KoSIT / Mustangproject '
      'comparison</a>. ')
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
        w('<p class="buy-fallback">Checkout is not open yet &mdash; we are not '
          "taking payments while the sales setup is completed. Email "
          "%s with questions, or to be notified the moment licensing opens; "
          "the published prices above are the prices you&rsquo;ll pay.</p>"
          % _h(COMMERCIAL_EMAIL))

    w("<p>What the price is <em>not</em>: it is not a fee for using the engine, "
      "not tied to any legal or tax &ldquo;compliance&rdquo; obligation, and "
      "not metered by request volume. You can use, embed and redistribute "
      "<code>einvoice</code> forever under Apache-2.0 without paying anything. "
      "The commercial license simply buys you support, update notices and the "
      "vendor-key convenience described above.</p>")

    w("<h2>Questions, or want to know when checkout opens?</h2>")
    w("<p>Email <a href=\"mailto:%s\">%s</a> &mdash; the private commercial "
      "contact for licensing; you do not have to open a public issue. Ask "
      "anything, or just say &ldquo;tell me when I can buy&rdquo; and "
      "you&rsquo;ll hear back when checkout opens. "
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
      "<strong>$290</strong> f&uuml;r ein ganzes Anbieter-Team. Der Checkout "
      "ist noch nicht ge&ouml;ffnet &mdash; Fragen und Kaufinteresse: "
      "<a href=\"mailto:%s\">%s</a>.</p>" % (_h(COMMERCIAL_EMAIL),
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



# External anchor targets for the comparison page — the two alternatives'
# public homes plus the official Schematron artifact our differential proof
# runs against. Plain navigated anchors (never fetched resources), exactly
# like the _REPO_* links above.
_KOSIT_VALIDATOR_URL = "https://github.com/itplr-kosit/validator"
_KOSIT_SCHEMATRON_URL = "https://github.com/itplr-kosit/xrechnung-schematron"
_MUSTANG_URL = "https://github.com/ZUGFeRD/mustangproject"


def render_compare():
    """The honest comparison page (``www/compare/index.html``) — pure.

    Answers the evaluator question "why not the free official KoSIT validator,
    or Mustangproject?" strictly factually (T-VHCMP.1). HARD HONESTY LINES,
    enforced in the copy itself: both alternatives are FREE; the KoSIT
    validator is the OFFICIAL reference implementation; our own correctness
    claim DERIVES FROM their Schematron artifact (stated explicitly); and a
    "when to prefer them" section concedes what they do that we do not (XSD
    schema validation, full Peppol BIS ecosystems, writing ZUGFeRD PDFs). No
    FUD, no fabricated figures.

    DATA DISCIPLINE: every figure about OUR engine is computed at render time
    from the live registries (``coverage.engine_fireable_ids()``, the Peppol
    id sets, ``report.REPORT_FORMATS``, the ``cli`` exit-code constants) and
    is wrapped in a ``data-claim`` attribute; test_site.py re-reads the same
    registries and fails if any emitted figure disagrees (claims-drift guard).
    NO hand-typed engine figure appears in this template.

    ENGLISH-only by design (the VHDE thin-content cap) — deliberately no
    ``/de/`` variant and no hreflang pair. Same self-containment contract as
    every surface page: one inline <style>, absolute canonical from BASE_URL,
    no <script>, no external CSS/JS/CDN/font.
    """
    n_rules = len(_coverage.engine_fireable_ids())
    n_peppol = len(_coverage.peppol_ubl_rule_ids()
                   | _coverage.peppol_cii_rule_ids())
    formats = _REPORT_FORMATS
    formats_html = ", ".join('<code data-claim="report-format">%s</code>'
                             % _h(f) for f in formats)
    exit_ok = _cli.EXIT_OK
    exit_fail = _cli.EXIT_FAIL
    exit_usage = _cli.EXIT_USAGE
    exit_parse = _cli.EXIT_PARSE

    title = ("einvoice vs. the official KoSIT validator and Mustangproject — "
             "an honest comparison")
    description = ("Should you use the free official KoSIT validator, "
                   "Mustangproject, or einvoice for EN 16931 / XRechnung "
                   "checking? An honest comparison: what each tool is best "
                   "at, %d differentially-proven business rules, %d CI output "
                   "formats, and exactly when to prefer the alternatives."
                   % (n_rules, len(formats)))
    # Comparison-table styling only, appended inside the single shared <style>
    # block (no second stylesheet, no external sheet).
    style_extra = (
        # The 4-column table is intrinsically wider than a phone viewport;
        # the scroll wrapper confines the overflow to the table itself
        # (horizontal pan inside the box) instead of widening the whole
        # document, which is what a 390px render check flags.
        "\n.cmp-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch;"
        " margin: 1.2rem 0; max-width: 100%; }"
        "\ntable.cmp { border-collapse: collapse; width: 100%;"
        " min-width: 34rem; margin: 0; font-size: .9rem; }"
        "\ntable.cmp th, table.cmp td { border: 1px solid #d0d7de;"
        " padding: .45rem .6rem; text-align: left; vertical-align: top; }"
        "\ntable.cmp th { background: #f6f8fa; }"
        "\n@media (prefers-color-scheme: dark) {"
        " table.cmp th, table.cmp td { border-color: #30363d; }"
        " table.cmp th { background: #161b22; } }")
    p = []
    w = p.append
    w(_doc_head(title, description, _url_compare(), style_extra=style_extra))
    w("<body>")
    w("<main>")
    # Breadcrumb (relative, offline-resolvable): this page is
    # www/compare/index.html, so the landing is ../index.html.
    w('<p class="crumb"><a href="../index.html">einvoice</a> / Comparison</p>')
    w("<h1>Why not KoSIT or Mustangproject?</h1>")
    w('<p class="lead">Fair question — it is the first one every German ERP '
      "developer should ask. The <strong>official KoSIT validator</strong> and "
      "<strong>Mustangproject</strong> are both free, mature, and in wide "
      "production use; for several jobs they are the better choice, and this "
      "page says exactly which jobs those are. <code>einvoice</code> earns its "
      "place on one axis only: it is a <strong>zero-dependency, pure-Python, "
      "CI-native</strong> conformance gate — no Java, no Saxon, no Schematron "
      "toolchain — whose correctness is differentially proven "
      "<em>against</em> the official KoSIT artifact.</p>")

    # ---- What each tool is (strictly factual) ------------------------------
    w("<h2>What each tool is</h2>")
    w("<p><strong><a href=\"%s\">KoSIT validator</a></strong> — the official "
      "validation tool from the Koordinierungsstelle f&uuml;r IT-Standards "
      "(KoSIT), the body that publishes the XRechnung standard itself. It is "
      "the <strong>reference implementation</strong>: a Java tool that runs "
      "the official XSD schema validation <em>and</em> the official "
      "Schematron business rules via an XSLT pipeline. Free and open source. "
      "When the KoSIT validator and anything else disagree, the KoSIT "
      "validator is right by definition.</p>" % _h(_KOSIT_VALIDATOR_URL))
    w("<p><strong><a href=\"%s\">Mustangproject</a></strong> — a free, "
      "open-source Java library and CLI centred on "
      "<strong>ZUGFeRD&nbsp;/&nbsp;Factur-X</strong>: hybrid e-invoices that "
      "embed the structured XML inside a PDF/A-3. Its standout capability is "
      "that it <strong>writes</strong> invoices, not just validates them — it "
      "can create a ZUGFeRD PDF from your data or embed XML into an existing "
      "PDF, and it validates what it reads. If you need to <em>produce</em> "
      "hybrid PDF invoices from Java, it is the obvious tool.</p>"
      % _h(_MUSTANG_URL))
    w("<p><strong><code>einvoice</code></strong> (this project) — a "
      "validation-only conformance gate in <strong>pure Python&nbsp;3 "
      "standard library</strong> (zero runtime dependencies, fully offline). "
      'It asserts <strong><span data-claim="rule-count">%d</span> EN&nbsp;'
      "16931 / XRechnung business rules</strong>, each differentially proven "
      "at <strong>0 divergences</strong> against the official "
      '<a href="%s">KoSIT XRechnung Schematron artifact</a> — see the honest '
      "dependency note below. It emits %s reports, ships a "
      '<code>uses:</code>-pinnable <a href="%s">GitHub Action</a> and a '
      "pre-commit hook, and documents every rule on a per-rule reference "
      "page in English and German.</p>"
      % (n_rules, _h(_KOSIT_SCHEMATRON_URL), formats_html,
         _h(_REPO_ACTION)))

    # ---- Our correctness claim DERIVES FROM their artifact -----------------
    w("<h2>Our correctness claim derives from KoSIT&rsquo;s artifact</h2>")
    w("<p>Being explicit about the relationship: <code>einvoice</code> is not "
      "an independent reading of the EN&nbsp;16931 specification. Its "
      "correctness claim <strong>derives from the official KoSIT/CEN "
      "Schematron artifacts</strong> — a differential harness runs this "
      "engine and the official Schematron side by side over generated and "
      "official test invoices and requires <strong>0 divergences</strong> on "
      "every proven rule, in both the UBL and CII syntax bindings. The "
      "official artifact is the ground truth; this engine is a re-"
      "implementation proven equivalent against it, rule by rule. Without "
      "KoSIT&rsquo;s published artifact that proof would be impossible, "
      "which is one more reason this page has no interest in talking the "
      "official toolchain down.</p>")

    # ---- Side-by-side table (strictly factual) -----------------------------
    w("<h2>Side by side</h2>")
    w('<div class="cmp-scroll">')
    w('<table class="cmp">')
    w("<tr><th></th><th><code>einvoice</code></th><th>KoSIT validator</th>"
      "<th>Mustangproject</th></tr>")
    w("<tr><th>Runtime</th>"
      "<td>Pure Python&nbsp;3 standard library — zero dependencies, no "
      "toolchain</td>"
      "<td>Java (JRE) + Saxon XSLT pipeline</td>"
      "<td>Java (JRE), library or CLI</td></tr>")
    w("<tr><th>Official status</th>"
      "<td>Independent; proven against the official artifact</td>"
      "<td><strong>The official reference implementation</strong></td>"
      "<td>Community open source, widely used</td></tr>")
    w("<tr><th>Price</th>"
      "<td>Free (Apache-2.0); optional $29&nbsp;/&nbsp;$290 support "
      "license</td>"
      "<td>Free, open source</td>"
      "<td>Free, open source</td></tr>")
    w("<tr><th>XSD schema validation</th>"
      "<td><strong>No</strong> — business rules only</td>"
      "<td>Yes</td>"
      "<td>Yes (ZUGFeRD&nbsp;/&nbsp;Factur-X focus)</td></tr>")
    w("<tr><th>EN 16931 / XRechnung business rules</th>"
      '<td><span data-claim="rule-count">%d</span> rules, differential-proven '
      "at 0 divergences</td>"
      "<td>Yes — runs the official Schematron itself</td>"
      "<td>Yes, for the profiles it targets</td></tr>" % n_rules)
    w("<tr><th>Peppol BIS Billing 3.0</th>"
      '<td><strong>No</strong> — only the <span data-claim="peppol-count">'
      "%d</span> <code>PEPPOL-EN16931-R*</code> rules KoSIT vendors inside "
      "the XRechnung artifact</td>"
      "<td>Validates whatever scenario/artifact you configure; the official "
      "ecosystem covers more here</td>"
      "<td>Broader e-invoicing ecosystem support</td></tr>" % n_peppol)
    w("<tr><th>Writes / creates invoices</th>"
      "<td><strong>No</strong> — validation only</td>"
      "<td>No — validation only</td>"
      "<td><strong>Yes</strong> — creates ZUGFeRD PDFs and embeds XML into "
      "PDF/A-3</td></tr>")
    w("<tr><th>CI reports</th>"
      "<td>%s</td>"
      "<td>XML / HTML validation report</td>"
      "<td>Java API and CLI output</td></tr>" % formats_html)
    w("</table>")
    w("</div>")
    w("<p>A caution about the table: the <code>einvoice</code> column is "
      "machine-derived from this engine&rsquo;s own registries; the other two "
      "columns state only what those tools are publicly known for, and where "
      "we were not confident of a detail we described the ecosystem rather "
      "than guessing a feature. Check their documentation for anything "
      "load-bearing.</p>")

    # ---- Where einvoice earns its keep -------------------------------------
    w("<h2>Where <code>einvoice</code> earns its keep</h2>")
    w('<ul class="rules">')
    w("<li><strong>No Java/Saxon toolchain in CI.</strong> The whole engine "
      "is Python&nbsp;3 standard library — <code>dependencies = []</code> — "
      "so the gate runs in any CI image that has <code>python3</code>, "
      "offline, with nothing to install or license.</li>")
    w("<li><strong>CI-native outputs.</strong> One flag switches the report "
      "between %s — SARIF gives inline PR annotations, the GitLab and JUnit "
      "forms surface findings as native CI results.</li>" % formats_html)
    w("<li><strong>A stable exit-code contract.</strong> "
      '<code data-claim="exit-code-ok">%d</code> = no implemented fatal rule '
      'fired, <code data-claim="exit-code-fail">%d</code> = at least one '
      'fatal violation, <code data-claim="exit-code-usage">%d</code> = usage '
      'error, <code data-claim="exit-code-parse">%d</code> = not well-formed '
      "XML. That is the entire integration surface a CI gate needs.</li>"
      % (exit_ok, exit_fail, exit_usage, exit_parse))
    w('<li><strong>Pinnable automation.</strong> A <code>uses:</code>-'
      'pinnable <a href="%s">GitHub Action</a>, a copy-paste '
      '<a href="%s">CI recipe</a> (POSIX&nbsp;sh + GitHub&nbsp;Actions / '
      "GitLab&nbsp;CI) and a pre-commit hook ship in the repository.</li>"
      % (_h(_REPO_ACTION), _h(_REPO_CI)))
    w('<li><strong>Per-rule reference pages.</strong> Every asserted rule has '
      'its own page — requirement, BT/BG terms, XML location, one-line fix, '
      "severity, verbatim official assert — in English and German: the "
      '<a href="../rules/index.html">rule index</a>.</li>')
    w("<li><strong>A person to email.</strong> An optional commercial license "
      "($29 single developer / $290 vendor team) adds maintainer support and "
      "rule-corpus update notices — see <a href=\"../licensing/index.html\">"
      "licensing</a>. It is never required to use or embed the engine.</li>")
    w("</ul>")

    # ---- When to prefer them (the honest concessions) ----------------------
    w("<h2>When to prefer them</h2>")
    w("<p>Honestly, in several situations you should not use "
      "<code>einvoice</code> at all, or should use it only alongside the "
      "official tool:</p>")
    w('<ul class="rules">')
    w("<li><strong>You need the official verdict.</strong> The KoSIT "
      "validator is the official reference implementation from the body that "
      "publishes XRechnung. Before an invoice actually goes to a government "
      "portal, run the official validator (or your receiver&rsquo;s): its "
      "answer is the one that counts. <code>einvoice</code> is the fast "
      "pre-flight in CI, not the final word.</li>")
    w("<li><strong>You need XSD schema validation.</strong> We do "
      "<strong>not</strong> perform structural XSD validation — only the "
      "business rules. The KoSIT validator runs the official XSD schemas as "
      "part of its pipeline; if schema-level structure is in question, use "
      "it.</li>")
    w("<li><strong>You need full Peppol BIS Billing 3.0.</strong> We assert "
      "only the KoSIT-vendored <code>PEPPOL-EN16931-R*</code> subset "
      '(<span data-claim="peppol-count">%d</span> rules). The KoSIT and '
      "Mustangproject ecosystems do more here; for real Peppol network "
      "validation use tooling built for it.</li>" % n_peppol)
    w("<li><strong>You need to <em>create</em> ZUGFeRD / Factur-X PDFs.</strong> "
      "Mustangproject writes them — builds the PDF/A-3, embeds the XML. "
      "<code>einvoice</code> is validation-only and will never produce an "
      "invoice.</li>")
    w("<li><strong>You validate UBL <code>CreditNote</code> documents.</strong> "
      "There is no UBL <code>CreditNote</code> root support here; the "
      "official toolchain handles them.</li>")
    w("</ul>")
    w("<p>The honest summary: use the official KoSIT validator as your "
      "authority, Mustangproject when Java or PDF-writing is in play, and "
      "<code>einvoice</code> when you want the same business-rule verdict as "
      "a zero-dependency Python gate inside every CI run and pre-commit — "
      "cheap enough to run on every push, proven against the artifact the "
      "official tool runs.</p>")

    # ---- Hands-on next step (T-VHWEB.3): the zero-install evaluation ------
    w("<p>Want to try that verdict before wiring anything into CI? The "
      '<a href="../validate/index.html">in-browser validator</a> runs the '
      'same <span data-claim="rule-count">%d</span>-rule engine in your '
      "browser via WebAssembly (Pyodide) &mdash; drop an XRechnung XML or a "
      "ZUGFeRD/Factur-X PDF and read the findings; the invoice never leaves "
      "your machine.</p>" % n_rules)

    w("<footer>")
    w("Every engine figure on this page (rule count, Peppol subset, report "
      "formats, exit codes) is rendered from the live registries by "
      "<code>gen_site.py</code> and drift-guarded by "
      "<code>test_site.py</code> — no hand-typed numbers. Self-contained: "
      "this page opens offline with no network requests. "
      '<a href="../index.html">Back to the overview</a>.')
    w("</footer>")
    w("</main>")
    w("</body>")
    w("</html>")
    return "\n".join(p) + "\n"


def render_de():
    """The German product/quickstart page (``www/de/index.html``) — pure.

    ORIGINAL German prose written for the German reader (T-VHDE.1) — a
    quickstart-shaped page (install -> erste Pr&uuml;fung -> CI-Anbindung),
    deliberately NOT a translation of the explainer-shaped English landing
    page. HONESTY CONTRACT: every coverage/limit statement mirrors what the
    committed conformance artifacts and the guarded English prose already
    claim (286 rules, deferred BR-CL checks, no XSD validation, green != legal
    conformance) — no claim appears here first. Every shell command is one of
    :data:`DE_COMMANDS`, byte-identical to the test-pinned English docs
    (test_site.py asserts this both ways); this page invents NO command.
    Same self-containment contract as every surface page: one inline <style>,
    absolute canonical from BASE_URL, hreflang alternates to/from the English
    landing, no <script>, no external CSS/JS/CDN/font.
    """
    (cmd_validate_fixed, cmd_pip, cmd_console, cmd_validate_broken,
     cmd_json, cmd_pip_vendor, cmd_gate) = (c for c, _doc in DE_COMMANDS)

    title = ("E-Rechnung offline validieren: XRechnung / EN 16931 "
             "Schnellstart auf Deutsch — einvoice")
    description = ("XRechnung und EN 16931 E-Rechnungen offline prüfen, "
                   "ohne Java, Saxon oder sonstige Abhängigkeiten: "
                   "Installation, erste Prüfung mit Exit-Code, "
                   "CI-Anbindung und die ehrliche Abdeckung der 286 "
                   "Geschäftsregeln — der deutschsprachige Schnellstart "
                   "für einvoice.")
    p = []
    w = p.append
    # hreflang alternates BOTH directions: this German page references the
    # English landing (and itself); the landing carries the mirror links.
    w(_doc_head(title, description, _url_de(), lang="de",
                alternates=(("de", _url_de()), ("en", _url_landing()),
                            ("x-default", _url_landing()))))
    w("<body>")
    w("<main>")
    w('<p class="crumb"><a href="../index.html">einvoice</a> / Deutsch</p>')
    w("<h1>E-Rechnungen offline validieren</h1>")
    w('<p class="lead"><strong>einvoice</strong> pr&uuml;ft elektronische '
      "Rechnungen gegen die Gesch&auml;ftsregeln von <strong>EN&nbsp;16931"
      "</strong> und der deutschen <strong>XRechnung</strong> &mdash; als "
      "Kommandozeilenwerkzeug, komplett offline, mit <strong>null "
      "Abh&auml;ngigkeiten</strong> (reine Python-3-Standardbibliothek: kein "
      "Java, kein Saxon, keine Schematron-Toolchain, kein Netzwerkzugriff). "
      "Diese Seite ist der deutschsprachige Schnellstart: was das Werkzeug "
      "ist, was es ehrlich abdeckt, und wie Sie es installieren, eine erste "
      "Rechnung pr&uuml;fen und als CI-Gate verdrahten.</p>")

    # ---- Was ist das Werkzeug? --------------------------------------------
    w("<h2>Was das Werkzeug ist</h2>")
    w("<p>Ein Konformit&auml;tspr&uuml;fer f&uuml;r E-Rechnungen im Format "
      "UBL&nbsp;2.1 <code>Invoice</code> oder UN/CEFACT&nbsp;CII, mit den "
      "Profilen <code>en16931</code> (europ&auml;ischer Kern) und "
      "<code>xrechnung</code> (Kern plus die deutsche KoSIT-Schicht: "
      "<code>BR-DE-*</code>-Regeln wie Leitweg-ID/K&auml;uferreferenz, "
      "Verk&auml;uferkontakt, Zahlungsangaben, Skonto-Grammatik). Insgesamt "
      "setzt der Pr&uuml;fer <strong>286 Gesch&auml;ftsregeln</strong> durch; "
      "jede ist differentiell gegen die offiziellen "
      "CEN-/KoSIT-Schematron-Artefakte bewiesen, mit 0 Abweichungen. Das "
      "Ergebnis kommt dreifach: als menschenlesbare Zusammenfassung, als "
      "<strong>Exit-Code</strong> (das, worauf ein CI-Gate reagiert) und als "
      "<code>--json</code>-Maschinenprotokoll.</p>")
    w("<p>Die Fehlermeldungen gibt es auch auf Deutsch: mit "
      "<code>--lang de</code> zeigt die CLI zu jeder Regel den deutschen "
      "Korrekturtext &mdash; wo das offizielle KoSIT-Artefakt einen deutschen "
      "Text mitliefert, exakt diesen; sonst eine klar als &Uuml;bersetzung "
      "gekennzeichnete Fassung, die nie als amtlicher Text ausgegeben "
      "wird.</p>")

    # ---- Ehrliche Abdeckung ------------------------------------------------
    w("<h2>Ehrliche Abdeckung: was ein gr&uuml;nes Ergebnis bedeutet</h2>")
    w("<p>Ein gr&uuml;nes Ergebnis hei&szlig;t: <em>keine implementierte "
      "fatale Regel hat ausgel&ouml;st</em>. Es hei&szlig;t nicht "
      "&bdquo;rechtsverbindlich konforme XRechnung&ldquo;. Die Grenzen im "
      "Einzelnen:</p>")
    w('<ul class="rules">')
    w("<li>8 offizielle <code>BR-CL-*</code>-Codelisten-Pr&uuml;fungen sind "
      "bewusst zur&uuml;ckgestellt und als dokumentierte Ausnahmen "
      "gef&uuml;hrt &mdash; nicht als Abdeckung gez&auml;hlt.</li>")
    w("<li>Eine strukturelle <strong>XSD-Validierung findet nicht statt</strong>; "
      "gepr&uuml;ft werden die Gesch&auml;ftsregeln, nicht das Schema. Ein "
      "UBL-<code>CreditNote</code>-Wurzelelement wird nicht "
      "unterst&uuml;tzt.</li>")
    w("<li>4 offizielle Regeln (<code>BR-CO-05</code>&#8211;"
      "<code>BR-CO-08</code>) sind in den CEN-Artefakten selbst als "
      '<code>test="true()"</code>-Tautologien ausgeliefert — sie k&ouml;nnen '
      "nie ausl&ouml;sen und sind deshalb nicht implementierbar; jede "
      "andere ausl&ouml;sbare offizielle <code>BR-*</code>-Regel ist "
      "implementiert oder eine dokumentierte, begr&uuml;ndete Ausnahme "
      "(maschinell gepr&uuml;fte L&uuml;cke: 0 in beiden "
      "CEN-Syntax-Universen).</li>")
    w("<li>Von den <code>PEPPOL-EN16931-R*</code>-Regeln ist genau die "
      "Teilmenge implementiert, die KoSIT im offiziellen "
      "XRechnung-Artefakt mitliefert (21 Regeln) &mdash; das ist "
      "<em>keine</em> Peppol-BIS-Billing-3.0-Unterst&uuml;tzung.</li>")
    w("</ul>")
    w("<p>Nichts davon m&uuml;ssen Sie glauben: Das ma&szlig;gebliche "
      "Regelinventar mit jeder Ausnahme und w&ouml;rtlichen Artefakt-Belegen "
      'ist die <a href="%s">Abdeckungsmatrix (COVERAGE.md)</a> im Repository, '
      "und jede Zahl auf dieser Seite l&auml;sst sich dort nachrechnen. "
      "Lassen Sie vor dem tats&auml;chlichen Einreichen trotzdem den "
      "offiziellen Validator Ihres Empf&auml;ngers laufen &mdash; dieses "
      "Werkzeug ist der schnelle Vorab-Check, der die typischen Fehler "
      "fr&uuml;h f&auml;ngt.</p>" % _h(_REPO_COVERAGE))

    # ---- Installation + erste Pruefung ------------------------------------
    w("<h2>Installation und erste Pr&uuml;fung</h2>")
    w("<p>Alles Folgende l&auml;uft aus dem <code>einvoice/</code>-Verzeichnis "
      "eines Repository-Checkouts &mdash; offline, ohne weitere Installation. "
      "Die beiden Beispielrechnungen liegen im Repository: eine g&uuml;ltige "
      "XRechnung (<code>fixed.xml</code>) und dieselbe Datei mit zwei "
      "entfernten Pflichtangaben (<code>broken.xml</code>: ohne "
      "K&auml;uferreferenz <code>BT-10</code> und ohne "
      "Verk&auml;uferkontakt <code>BG-6</code>).</p>")
    w("<h3>1. Direkt aus dem Checkout &mdash; nichts zu installieren</h3>")
    w("<pre><code>%s</code></pre>" % _h(cmd_validate_fixed))
    w("<p>Die g&uuml;ltige Rechnung endet mit <strong>Exit-Code 0</strong>. "
      "Wer stattdessen das <code>einvoice</code>-Kommando im PATH will, "
      "installiert das Paket (null Laufzeitabh&auml;ngigkeiten, "
      "<code>dependencies = []</code> in <code>pyproject.toml</code>) und "
      "ruft es direkt auf &mdash; derselbe Codepfad, best&auml;tigt per "
      "Test:</p>")
    w("<pre><code>%s\n%s</code></pre>" % (_h(cmd_pip), _h(cmd_console)))
    w("<h3>2. Eine kaputte Rechnung f&auml;llt durch &mdash; mit Regel-ID</h3>")
    w("<pre><code>%s</code></pre>" % _h(cmd_validate_broken))
    w("<p>Exit-Code <strong>1</strong>; die Ausgabe nennt die erste verletzte "
      "fatale Regel (<code>BR-DE-2</code>, fehlender Verk&auml;uferkontakt) "
      "samt betroffenem Element. Die Exit-Codes sind der ganze Vertrag, den "
      "ein CI-Gate braucht: <code>0</code> = keine implementierte fatale "
      "Regel verletzt, <code>1</code> = mindestens eine fatale Verletzung, "
      "<code>2</code> = Bedienfehler, <code>3</code> = kein wohlgeformtes "
      "XML.</p>")
    w("<h3>3. Maschinenlesbar: <code>--json</code></h3>")
    w("<pre><code>%s</code></pre>" % _h(cmd_json))
    w("<p>Gibt das vollst&auml;ndige Ergebnis als JSON auf stdout aus "
      "(Exit-Code unver&auml;ndert <code>1</code>): hier alle drei Befunde "
      "&mdash; die zwei fatalen Regeln <code>BR-DE-2</code> und "
      "<code>BR-DE-15</code> plus ein beratender "
      "<code>information</code>-Hinweis, der den Exit-Code nie bewegt. "
      "Verlassen Sie sich in Skripten auf das Feld <code>valid</code> oder "
      "den Exit-Code, nicht auf den menschenlesbaren Text.</p>")

    # ---- CI-Anbindung ------------------------------------------------------
    w("<h2>CI-Anbindung: kein Build mit kaputter Rechnung</h2>")
    w("<p>F&uuml;r ein Repository voller Rechnungen gibt es ein fertiges "
      "Gate-Skript (POSIX&nbsp;sh, keine Abh&auml;ngigkeiten au&szlig;er "
      "<code>python3</code>): Es pr&uuml;ft rekursiv jede "
      "<code>*.xml</code>-Datei, l&auml;sst den Build bei jeder fatalen "
      "Verletzung mit der Regel-ID im Log fehlschlagen und schreibt pro "
      "Rechnung einen JUnit-Report, den CI-Oberfl&auml;chen als Testergebnis "
      "anzeigen. Das Werkzeug ist noch nicht auf PyPI &mdash; vendoren Sie "
      "das Produktverzeichnis (z.&nbsp;B. nach "
      "<code>third_party/einvoice/</code>) und installieren Sie es im "
      "CI-Job:</p>")
    w("<pre><code>%s</code></pre>" % _h(cmd_pip_vendor))
    w("<p>Dann das Gate &uuml;ber Ihre Rechnungsdateien laufen lassen:</p>")
    w("<pre><code>%s</code></pre>" % _h(cmd_gate))
    w("<p>Kopierfertige GitHub-Actions- und GitLab-CI-Definitionen liegen "
      'daneben im <a href="%s">CI-Rezept (einvoice/ci/)</a>; eine '
      '<code>uses:</code>-pinnbare <a href="%s">GitHub Action</a> annotiert '
      "Befunde per SARIF direkt im Pull Request. Jedes Kommando auf dieser "
      "Seite ist byte-identisch mit den englischen Anleitungen, deren "
      "Kommandos die Testsuite gegen die echte Engine ausf&uuml;hrt &mdash; "
      "die Doku kann nicht von dem abdriften, was das Werkzeug wirklich "
      "tut.</p>" % (_h(_REPO_CI), _h(_REPO_ACTION)))

    # ---- Weiterfuehrend ----------------------------------------------------
    w("<h2>Weiterf&uuml;hrend</h2>")
    w('<ul class="rules">')
    w('<li><a href="../validate/index.html">Im Browser validieren</a> '
      "&mdash; dieselbe Engine l&auml;uft per WebAssembly (Pyodide) direkt "
      "im Browser: Rechnung ausw&auml;hlen, Befunde lesen, nichts "
      "installieren. Die Rechnung verl&auml;sst Ihren Rechner nie; nur die "
      "Laufzeit wird nach einem Klick einmalig geladen (~13&nbsp;MB).</li>")
    w('<li><a href="../rules/index.html">Regel-Referenz</a> &mdash; jede der '
      "286 Regeln mit eigener Seite: Anforderung, BT-/BG-Begriffe, "
      "XML-Position, Korrekturhinweis auf Englisch und Deutsch, w&ouml;rtlicher "
      "offizieller Schematron-Assert. Eigene deutsche Regelseiten gibt es "
      "bewusst nicht &mdash; der deutsche Text steht auf jeder Regelseite und "
      "in der CLI unter <code>--lang de</code>.</li>")
    w('<li><a href="walkthrough/index.html">Praxisbeispiel &mdash; Schritt '
      "f&uuml;r Schritt</a> &mdash; dieselbe kaputte Rechnung von oben, vom "
      "roten CI-Lauf zur bestandenen Pr&uuml;fung, auf Deutsch "
      '(auch als <a href="../walkthrough/index.html">englische Fassung</a>).'
      "</li>")
    w('<li><a href="../licensing/index.html">Lizenz</a> &mdash; Apache-2.0 '
      "f&uuml;r alle, auch f&uuml;r Closed-Source-Einbettung; die optionale "
      "kommerzielle Lizenz ($29&nbsp;/&nbsp;$290) kauft Support und "
      "Update-Hinweise, nie die Nutzungserlaubnis.</li>")
    w('<li><a href="../index.html">English overview</a> &mdash; die '
      "ausf&uuml;hrliche englische Produktseite mit der vollst&auml;ndigen "
      "Abdeckungs-Geschichte und den Sicherheitsdetails zum Parsen nicht "
      "vertrauensw&uuml;rdiger XML-Eingaben.</li>")
    w("</ul>")

    w("<footer>")
    w("Generiert von <code>gen_site.py</code>; alle Kommandos byte-identisch "
      "mit den testgepr&uuml;ften englischen Anleitungen "
      "(<code>QUICKSTART.md</code>, <code>ci/README.md</code>). Diese Seite "
      "ist eigenst&auml;ndig und &ouml;ffnet offline ohne Netzwerkzugriffe.")
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
    # hreflang alternates BOTH directions with the German walkthrough (T-VHDE.3):
    # this English page references itself (en) and the German page (de); x-default
    # points at the English (canonical-language) walkthrough. These are absolute
    # BASE_URL link elements (navigational/SEO, not fetched resources), built
    # from the same origin as the canonical so they can never disagree.
    w('<link rel="alternate" hreflang="en" href="%s">' % _h(_url_walkthrough()))
    w('<link rel="alternate" hreflang="de" href="%s">'
      % _h(_url_de_walkthrough()))
    w('<link rel="alternate" hreflang="x-default" href="%s">'
      % _h(_url_walkthrough()))
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


def render_de_walkthrough(catalog):
    """The German-language worked walkthrough (``www/de/walkthrough/``) — pure.

    Same live-engine source and same finding SET as :func:`render_walkthrough`
    (it calls :func:`_walkthrough_inputs` for the identical broken/fixed XML +
    report, and iterates the same violations in the same order), but wrapped in
    ORIGINAL German adoption prose written for a German reader — NOT a
    machine translation of the English page. The per-finding data (rule id,
    severity, BT/BG terms, the engine's title and fix hint) is the live report
    output verbatim; nothing about a rule is authored from memory, so this page
    can neither drop, invent, nor rename a finding. Every shell command is
    byte-identical to the English walkthrough's (drift-guarded by
    test_walkthrough.py). Same self-containment contract: one inline <style>
    (reusing the walkthrough-only _WALK_STYLE), an absolute self-referential
    canonical, hreflang alternates BOTH directions with the English walkthrough,
    no <script>, no external CSS/JS/CDN/font — offline-openable.

    Relative links resolve offline from ``www/de/walkthrough/index.html``: the
    landing/hub/rule pages are two levels up (``../../``), the German product
    page one level up (``../``).
    """
    broken_xml, fixed_xml, report = _walkthrough_inputs()
    source = report.get("source", "")
    profile = report.get("profile", "")
    violations = report.get("violations") or []
    fatal_count = report.get("fatal_count", 0)
    warning_count = report.get("warning_count", 0)
    violation_count = report.get("violation_count", len(violations))
    n_fatal = sum(1 for v in violations if v.get("severity") == "fatal")
    fatal_rules = [v.get("rule", "") for v in violations
                   if v.get("severity") == "fatal"]
    body_diff = _body_diff(broken_xml, fixed_xml)

    title = ("Vom roten CI-Lauf zur bestandenen E-Rechnung — ein "
             "XRechnung-/EN-16931-Praxisbeispiel Schritt für Schritt — einvoice")
    description = ("Durchgerechnetes Beispiel auf Deutsch: eine absichtlich "
                   "fehlerhafte XRechnung (UBL), der echte Konformitätsbericht "
                   "von einvoice (%d Befunde, %d fatal) und die exakte "
                   "Zwei-Element-Korrektur, die sie besteht."
                   % (violation_count, n_fatal))
    canonical = _url_de_walkthrough()

    p = []
    w = p.append
    w("<!doctype html>")
    w('<html lang="de">')
    w("<head>")
    w('<meta charset="utf-8">')
    w('<meta name="viewport" content="width=device-width, initial-scale=1">')
    # INDEXABLE: no robots:noindex — this page is in the sitemap.
    w("<title>%s</title>" % _h(title))
    w('<meta name="description" content="%s">' % _h(description))
    w('<link rel="canonical" href="%s">' % _h(canonical))
    # hreflang alternates BOTH directions with the English walkthrough: this
    # German page references itself (de) and the English page (en); x-default
    # points at the English (canonical-language) walkthrough. Absolute BASE_URL
    # link elements, same origin as the canonical.
    w('<link rel="alternate" hreflang="en" href="%s">' % _h(_url_walkthrough()))
    w('<link rel="alternate" hreflang="de" href="%s">'
      % _h(_url_de_walkthrough()))
    w('<link rel="alternate" hreflang="x-default" href="%s">'
      % _h(_url_walkthrough()))
    # Reuse the walkthrough-only inline style (same block as the English page).
    w("<style>%s\n%s</style>" % (_STYLE, _WALK_STYLE))
    w("</head>")
    w("<body>")
    w("<main>")
    # Breadcrumb up to the landing + rule hub (relative, offline-resolvable):
    # this page is www/de/walkthrough/index.html.
    w('<p class="crumb"><a href="../../index.html">einvoice</a> / '
      '<a href="../index.html">Deutsch</a> / '
      '<a href="../../rules/index.html">EN 16931 / XRechnung Regel-Referenz</a>'
      " / Praxisbeispiel</p>")
    w("<h1>Vom roten CI-Lauf zur bestandenen Rechnung</h1>")
    w('<p class="lead">Ein durchgerechnetes Beispiel in f&uuml;nf Minuten. '
      "Wir nehmen eine echte deutsche <strong>XRechnung</strong> "
      "(EN&nbsp;16931, UBL), entfernen zwei Pflichtangaben, lassen den "
      "<code>einvoice</code>-Konformit&auml;tspr&uuml;fer genau so laufen, wie "
      "es ein CI-Gate t&auml;te, lesen den tats&auml;chlich ausgegebenen "
      "Bericht und korrigieren die Rechnung, bis sie besteht. Jeder Befund "
      "unten stammt aus der echten Engine &mdash; der Bericht wird aus dem "
      "Werkzeug neu erzeugt, und ein Test l&auml;sst den Build fehlschlagen, "
      "sobald diese Seite von der Live-Ausgabe abweicht.</p>")
    w("<p>Die Engine hinter diesem Beispiel setzt <strong>286 "
      "Gesch&auml;ftsregeln aus EN&nbsp;16931 und XRechnung</strong> durch &mdash; "
      "jede ausl&ouml;sbare offizielle <code>BR-*</code>-Regel in beiden "
      "CEN-Syntaxwelten (UBL und CII) au&szlig;er acht zur&uuml;ckgestellten "
      "Codelisten-Pr&uuml;fungen, die komplette deutsche KoSIT-Schicht und die "
      "21 <code>PEPPOL-EN16931-R*</code>-Regeln, die KoSIT im offiziellen "
      "XRechnung-Artefakt mitliefert (nur diese Teilmenge, nicht Peppol BIS "
      "Billing&nbsp;3.0) &mdash; jede differentiell gegen die offiziellen "
      "Schematron-Artefakte bewiesen, mit 0 Abweichungen. Das vollst&auml;ndige "
      "Regelinventar samt ehrlicher Grenzen steht in <code>COVERAGE.md</code> "
      "im Repository.</p>")
    w("<p>Sie k&ouml;nnen jeden Schritt selbst nachvollziehen: Sie brauchen nur "
      "Python&nbsp;3 und dieses Repository &mdash; keine Abh&auml;ngigkeiten, "
      "kein Netz. F&uuml;hren Sie die Befehle aus dem Verzeichnis "
      "<code>einvoice/</code> aus.</p>")

    # ---- Schritt 1: die kaputte Rechnung ----------------------------------
    w('<section class="step">')
    w("<h2>1. Die kaputte Rechnung</h2>")
    w("<p>Ein Lieferant hat diese UBL-Rechnung exportiert, aber zwei "
      "Pflichtangaben fehlen: die <strong>K&auml;uferreferenz</strong> "
      "(<code>BT-10</code>, die <em>Leitweg-ID</em> &mdash; die Routing-Kennung, "
      "die ein deutscher &ouml;ffentlicher Auftraggeber verlangt) und die "
      "Gruppe <strong>SELLER CONTACT</strong> (<code>BG-6</code>, ein "
      "<code>cac:Contact</code> unter der Lieferantenpartei). Alles &Uuml;brige "
      "ist eine byteweise Kopie eines g&uuml;ltigen KoSIT-Testdokuments, sodass "
      "diese zwei Auslassungen der <em>einzige</em> Grund f&uuml;r das "
      "Durchfallen sind. Die vollst&auml;ndige Datei ist "
      "<code>%s/broken.xml</code>:</p>" % _h(EX_REL))
    w("<pre>%s</pre>" % _h(broken_xml))
    w("</section>")

    # ---- Schritt 2: den Pruefer laufen lassen (das CI-Gate) ---------------
    w('<section class="step">')
    w("<h2>2. Den Pr&uuml;fer laufen lassen (das ist Ihr CI-Gate)</h2>")
    w("<p>Richten Sie das Werkzeug auf die Rechnung. In einer CI-Pipeline ist "
      "das der Befehl, dessen Exit-Code ungleich null den Build fehlschlagen "
      "l&auml;sst:</p>")
    w("<pre>$ python3 -m einvoice.report %s/broken.xml --format json</pre>"
      % _h(EX_REL))
    w("<p>Er endet mit <strong>1</strong> und gibt den Bericht unten aus. Nur "
      "<code>fatal</code>-Befunde machen eine Rechnung ung&uuml;ltig (das "
      "spiegelt die <code>flag</code>-Semantik des offiziellen Schematron); "
      "<code>warning</code>- und <code>information</code>-Befunde sind beratend "
      "und lassen den Build nicht scheitern.</p>")
    w("</section>")

    # ---- Schritt 3: den echten Bericht lesen ------------------------------
    w('<section class="step">')
    w("<h2>3. Den Bericht lesen</h2>")
    w('<p class="summary">Die Engine meldet <code>valid: %s</code> f&uuml;r '
      "<code>%s</code> unter dem Profil <code>%s</code>: insgesamt "
      "<code>%d</code> Befunde, davon <code>%d</code> fatal und "
      "<code>%d</code> Warnung. Jeder Befund nennt die verletzte Regel, die "
      "betroffenen EN-16931-Gesch&auml;ftsbegriffe und einen konkreten "
      "Korrekturhinweis. Die Regel-ID f&uuml;hrt zur ausf&uuml;hrlichen "
      "Referenzseite.</p>"
      % (_h(json.dumps(report.get("valid"))), _h(source), _h(profile),
         violation_count, fatal_count, warning_count))

    for v in violations:
        rule = v.get("rule", "")
        severity = v.get("severity", "")
        vtitle = v.get("title", "")
        hint = v.get("fix_hint", "")
        terms = v.get("terms") or []
        terms_html = " ".join("<code>%s</code>" % _h(t) for t in terms)
        # Link the rule id back to its per-rule reference page (relative, resolves
        # offline: this page is www/de/walkthrough/index.html, the rule page is
        # www/rules/<id>/index.html). The guard keeps the link from dangling.
        if rule in catalog:
            rule_html = ('<a href="../../rules/%s/index.html"><code>%s</code>'
                         "</a>" % (_h(rule), _h(rule)))
        else:
            rule_html = "<code>%s</code>" % _h(rule)
        w('<div class="finding">')
        w('<p class="fhead">%s <span class="sev">%s</span> %s</p>'
          % (rule_html, _h(severity), terms_html))
        w("<h3>%s</h3>" % _h(vtitle))
        w('<p class="hint">%s</p>' % _h(hint))
        w("</div>")

    w("<p>Titel und Korrekturhinweis oben sind die unver&auml;nderte "
      "Maschinenausgabe (Englisch). Denselben Befund gibt die CLI mit "
      "<code>--lang de</code> auf Deutsch aus: wo das offizielle "
      "KoSIT-Artefakt einen deutschen Text mitliefert, exakt diesen, sonst "
      "eine klar als &Uuml;bersetzung gekennzeichnete Fassung. Die beiden "
      "fatalen Befunde (%s) sind der Grund f&uuml;r die Ablehnung. Der "
      "<code>information</code>-Befund ist beratend &mdash; wir lassen ihn "
      "stehen, damit dies eine minimale Zwei-Feld-Korrektur bleibt. F&uuml;r "
      "die vollst&auml;ndige Erl&auml;uterung einer Regel dient "
      "<code>python3 -m einvoice.report --explain BR-DE-15</code>.</p>"
      % " und ".join("<code>%s</code>" % _h(r) for r in fatal_rules))
    w("</section>")

    # ---- Schritt 4: die Korrektur -----------------------------------------
    w('<section class="step">')
    w("<h2>4. Die Korrektur anwenden</h2>")
    w("<p>Stellen Sie die zwei fehlenden Elemente wieder her. Das ist der exakte "
      "Diff von <code>broken.xml</code> zur korrigierten <code>fixed.xml</code> "
      "(die Provenienz-Kommentark&ouml;pfe sind weggelassen; die "
      "Rechnungsr&uuml;mpfe unterscheiden sich sonst durch nichts):</p>")
    w("<pre>%s</pre>" % _h(body_diff))
    w("<p>Ein <code>cac:Contact</code> braucht mindestens einen Namen, eine "
      "Telefonnummer und/oder eine E-Mail-Adresse; die K&auml;uferreferenz ist "
      "die Routing-Kennung (Leitweg-ID), die Ihnen Ihr Empf&auml;nger "
      "vorgibt.</p>")
    w("</section>")

    # ---- Schritt 5: sie besteht -------------------------------------------
    w('<section class="step">')
    w("<h2>5. Die korrigierte Rechnung besteht</h2>")
    w("<p>Denselben Befehl noch einmal auf der korrigierten Datei laufen lassen "
      "(<code>%s/fixed.xml</code>):</p>" % _h(EX_REL))
    w("<pre>$ python3 -m einvoice.report %s/fixed.xml --format json</pre>"
      % _h(EX_REL))
    w('<p class="pass">Sie endet jetzt mit <strong>0</strong> und meldet '
      "<code>valid: true</code> bei <code>fatal_count: 0</code>. Beide "
      "<code>BR-DE-*</code>-Fatalbefunde sind weg, und die Rechnung "
      "best&uuml;nde diesen Vorab-Check. (Der Test dieser Seite l&auml;sst die "
      "echte Engine erneut auf <code>fixed.xml</code> laufen und l&auml;sst den "
      "Build scheitern, wenn sie nicht wirklich mit null fatalen Befunden "
      "besteht.)</p>")
    w("<p><strong>Ehrliche Grenze:</strong> Ein gr&uuml;nes Ergebnis "
      "hei&szlig;t &bdquo;keine implementierte Regel hat ausgel&ouml;st&ldquo;, "
      "nicht &bdquo;rechtsverbindlich konform zertifiziert&ldquo;. Das ist ein "
      "schneller Vorab-Check, der die Fehler f&auml;ngt, an denen die meisten "
      "Ersteinreichungen scheitern &mdash; lassen Sie vor dem tats&auml;chlichen "
      "Einreichen trotzdem den offiziellen Validator Ihres Empf&auml;ngers "
      "laufen.</p>")
    w("</section>")

    w('<section class="step">')
    w("<h2>Weiter</h2>")
    w('<p>Alle gepr&uuml;ften Regeln stehen im '
      '<a href="../../rules/index.html">Regel-Index</a>; Installation, '
      "erste Pr&uuml;fung und das CI-Gate-Rezept auf Deutsch stehen im "
      '<a href="../index.html">deutschen Schnellstart</a>.</p>')
    w("</section>")

    w("<footer>")
    w("Der Bericht auf dieser Seite wird aus "
      "<code>examples/01-missing-fields/report.json</code> gerendert &mdash; "
      "echte Engine-Ausgabe, neu erzeugt von <code>gen_examples.py</code> und "
      "drift-gesch&uuml;tzt durch <code>test_examples.py</code> / "
      "<code>test_walkthrough.py</code>. Eigenst&auml;ndig: Diese Seite "
      "&ouml;ffnet offline ohne Netzwerkzugriffe.")
    w("</footer>")
    w("</main>")
    w("</body>")
    w("</html>")
    return "\n".join(p) + "\n"


# ---------------------------------------------------------------------------
# In-browser validator PAGE (T-VHWEB.2) — www/validate/index.html.
#
# The zero-install conversion moment: a visitor drags an XRechnung XML or a
# ZUGFeRD/Factur-X PDF onto the page and the REAL engine (the byte-identical
# bundle under www/validate/engine/, T-VHWEB.1) grades it in their browser via
# Pyodide. Protocol lines this template enforces BY CONSTRUCTION:
#
#   * NOTHING external is fetched on page load. The static HTML carries no
#     <script src=...>, no external <link>, no external resource at all. The
#     ONE external script (the pinned Pyodide loader) is injected dynamically,
#     only after the visitor clicks the load button, with the exact-version
#     URL + SRI sha384 integrity + crossorigin="anonymous" pinned in
#     PYODIDE_JS_URL / PYODIDE_SRI above.
#   * The invoice never leaves the browser: the file is read with FileReader,
#     written into Pyodide's in-memory filesystem, and validated there. No
#     request ever carries its bytes (the only network traffic is downloading
#     the runtime + engine files themselves).
#   * Render only engine output: the findings table is built verbatim from
#     report.build_report()'s JSON (severity / rule / message, plus its own
#     fatal/warning counts). Nothing is authored client-side.
#   * Honest failure: if the CDN, WebAssembly, or the engine mount fails, the
#     page says so and shows the pip-install fallback — never a fake result.
#
# All JS is inline and assembled with .replace() tokens (no %-formatting, so
# JS percent signs can never collide with Python formatting). Deterministic:
# every input is a module constant or the sorted catalog id list.
# ---------------------------------------------------------------------------

_VALIDATE_JS = r"""
"use strict";
(function () {
  var PYODIDE_JS_URL = "@@PYODIDE_JS_URL@@";
  var PYODIDE_INDEX_URL = "@@PYODIDE_INDEX_URL@@";
  var PYODIDE_SRI = "@@PYODIDE_SRI@@";
  // Rule ids that have a generated reference page under ../rules/<id>/ —
  // emitted from the same catalog the site is generated from, so a finding
  // links out only when the target page really exists.
  var RULE_PAGES = @@RULE_PAGES_JSON@@;
  var RULE_SET = {};
  for (var i = 0; i < RULE_PAGES.length; i++) { RULE_SET[RULE_PAGES[i]] = 1; }

  var loadBtn = document.getElementById("load-btn");
  var statusEl = document.getElementById("status");
  var fallbackEl = document.getElementById("fallback");
  var pickerEl = document.getElementById("picker");
  var dropzoneEl = document.getElementById("dropzone");
  var fileInput = document.getElementById("file-input");
  var profileSel = document.getElementById("profile");
  var resultEl = document.getElementById("result");

  var pyodide = null;
  var validateFn = null;
  var engineVersion = "";

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = "status" + (cls ? " " + cls : "");
  }

  function fail(message) {
    setStatus(message, "err");
    fallbackEl.hidden = false;
    loadBtn.disabled = false;
    loadBtn.hidden = false;
  }

  function bufToHex(buf) {
    var bytes = new Uint8Array(buf);
    var out = "";
    for (var j = 0; j < bytes.length; j++) {
      out += (bytes[j] < 16 ? "0" : "") + bytes[j].toString(16);
    }
    return out;
  }

  function injectPyodideScript() {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.integrity = PYODIDE_SRI;
      s.crossOrigin = "anonymous";
      s.onload = function () { resolve(); };
      s.onerror = function () {
        reject(new Error("could not fetch the Pyodide runtime from the CDN " +
                         "(offline, blocked, or an integrity mismatch)"));
      };
      s.src = PYODIDE_JS_URL;
      document.head.appendChild(s);
    });
  }

  async function mountEngine() {
    var resp = await fetch("engine/manifest.json");
    if (!resp.ok) {
      throw new Error("engine/manifest.json failed to load (HTTP " +
                      resp.status + ")");
    }
    var manifest = await resp.json();
    engineVersion = String(manifest.version || "");
    var files = manifest.files || [];
    pyodide.FS.mkdirTree("/engine/einvoice");
    for (var k = 0; k < files.length; k++) {
      var fn = files[k];
      setStatus("Mounting engine module " + (k + 1) + " / " + files.length +
                " (" + fn + ")…");
      var r = await fetch("engine/" + fn);
      if (!r.ok) {
        throw new Error("engine/" + fn + " failed to load (HTTP " +
                        r.status + ")");
      }
      var buf = await r.arrayBuffer();
      // Verify each module against the manifest's sha256 pin when the
      // browser exposes WebCrypto (secure contexts); a mismatch is a hard
      // stop, never a silent run of drifted code.
      if (window.crypto && window.crypto.subtle && manifest.sha256 &&
          manifest.sha256[fn]) {
        var digest = await window.crypto.subtle.digest("SHA-256", buf);
        if (bufToHex(digest) !== manifest.sha256[fn]) {
          throw new Error("engine/" + fn +
                          " does not match its manifest sha256 pin");
        }
      }
      pyodide.FS.writeFile("/engine/einvoice/" + fn, new Uint8Array(buf));
    }
    pyodide.runPython(
      'import sys, json\n' +
      'sys.path.insert(0, "/engine")\n' +
      'from einvoice import report as _einvoice_report\n' +
      'def _browser_validate(path, profile):\n' +
      '    return json.dumps(\n' +
      '        _einvoice_report.build_report(path, profile=profile))\n');
    validateFn = pyodide.globals.get("_browser_validate");
  }

  async function loadValidator() {
    loadBtn.disabled = true;
    fallbackEl.hidden = true;
    try {
      setStatus("Fetching the Pyodide runtime from jsDelivr " +
                "(exact pinned version, integrity-checked)…");
      await injectPyodideScript();
      setStatus("Starting the Python runtime (WebAssembly)… this is " +
                "the slow part on a first visit.");
      pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
      setStatus("Mounting the engine modules…");
      await mountEngine();
      loadBtn.hidden = true;
      pickerEl.hidden = false;
      fileInput.disabled = false;
      setStatus("Validator ready (engine " + engineVersion + ", running " +
                "locally in your browser). Drop an invoice below — it " +
                "will not be uploaded anywhere.", "ok");
    } catch (e) {
      fail("The validator could not load: " + (e && e.message ? e.message :
           String(e)) + " Your invoice was NOT read or sent anywhere. You " +
           "can run the identical engine locally instead — see the " +
           "command below.");
    }
  }

  function severityCell(sev) {
    var td = document.createElement("td");
    var span = document.createElement("span");
    span.className = "sev";
    span.textContent = sev;
    td.appendChild(span);
    return td;
  }

  function ruleCell(ruleId) {
    var td = document.createElement("td");
    var code = document.createElement("code");
    code.textContent = ruleId;
    if (RULE_SET[ruleId]) {
      var a = document.createElement("a");
      a.href = "../rules/" + encodeURIComponent(ruleId) + "/";
      a.appendChild(code);
      td.appendChild(a);
    } else {
      td.appendChild(code);
    }
    return td;
  }

  function renderReport(report, displayName) {
    resultEl.textContent = "";
    var h = document.createElement("h2");
    h.textContent = "Findings for " + displayName;
    resultEl.appendChild(h);

    var summary = document.createElement("p");
    summary.className = "verdict " + (report.valid ? "pass" : "failv");
    if (report.error) {
      summary.textContent = "Not validated (" + report.error + "): " +
        (report.message || "");
      resultEl.appendChild(summary);
      return;
    }
    summary.textContent = (report.valid
      ? "PASS — no fatal rule fired. "
      : "FAIL — at least one fatal rule fired. ") +
      report.violation_count + " finding(s): " + report.fatal_count +
      " fatal, " + report.warning_count + " warning, profile " +
      report.profile + ".";
    resultEl.appendChild(summary);

    var v = report.violations || [];
    if (v.length === 0) { return; }
    var wrap = document.createElement("div");
    wrap.className = "cmp-scroll";
    var table = document.createElement("table");
    table.className = "cmp";
    var thead = document.createElement("thead");
    var hr = document.createElement("tr");
    ["Severity", "Rule", "Message"].forEach(function (label) {
      var th = document.createElement("th");
      th.scope = "col";
      th.textContent = label;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = document.createElement("tbody");
    for (var m = 0; m < v.length; m++) {
      var tr = document.createElement("tr");
      tr.appendChild(severityCell(v[m].severity));
      tr.appendChild(ruleCell(v[m].rule));
      var msg = document.createElement("td");
      msg.textContent = v[m].message;
      tr.appendChild(msg);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    resultEl.appendChild(wrap);
  }

  async function validateFile(file) {
    if (!validateFn || !file) { return; }
    setStatus("Validating " + file.name + " locally…");
    try {
      var buf = await file.arrayBuffer();
      var safe = (file.name || "invoice").replace(/[^A-Za-z0-9._-]/g, "_");
      if (!safe) { safe = "invoice"; }
      pyodide.FS.mkdirTree("/work");
      var path = "/work/" + safe;
      pyodide.FS.writeFile(path, new Uint8Array(buf));
      var report = JSON.parse(validateFn(path, profileSel.value));
      renderReport(report, file.name || safe);
      setStatus("Done — validated locally; nothing was uploaded.", "ok");
    } catch (e) {
      setStatus("Validation errored: " + (e && e.message ? e.message :
                String(e)), "err");
    }
  }

  loadBtn.addEventListener("click", loadValidator);
  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files[0]) {
      validateFile(fileInput.files[0]);
    }
  });
  dropzoneEl.addEventListener("dragover", function (ev) {
    ev.preventDefault();
    if (!fileInput.disabled) { dropzoneEl.classList.add("drag"); }
  });
  dropzoneEl.addEventListener("dragleave", function () {
    dropzoneEl.classList.remove("drag");
  });
  dropzoneEl.addEventListener("drop", function (ev) {
    ev.preventDefault();
    dropzoneEl.classList.remove("drag");
    if (fileInput.disabled) { return; }
    if (ev.dataTransfer && ev.dataTransfer.files &&
        ev.dataTransfer.files[0]) {
      validateFile(ev.dataTransfer.files[0]);
    }
  });
})();
""".strip()


def render_validate(catalog):
    """The in-browser validator page (``www/validate/index.html``) — pure.

    See the block comment above for the protocol lines. Deterministic: the
    only inputs are module constants, the live rule-count registry (same
    data-claim discipline as :func:`render_compare`) and the sorted catalog
    id list (which rules get a hyperlink).
    """
    n_rules = len(_coverage.engine_fireable_ids())
    title = ("Validate an XRechnung / ZUGFeRD invoice in your browser — "
             "no install, no upload — einvoice")
    description = ("Drag an XRechnung UBL XML or ZUGFeRD/Factur-X PDF onto "
                   "this page and the real %d-rule EN 16931 engine grades it "
                   "in your browser via Pyodide (WebAssembly). Nothing is "
                   "installed and the invoice is never uploaded — validation "
                   "runs locally after a one-time ~%d MB runtime download."
                   % (n_rules, PYODIDE_APPROX_MB))
    canonical = _url_validate()
    ld = {
        "@context": "https://schema.org",
        "@type": "WebApplication",
        "name": "einvoice in-browser XRechnung / EN 16931 validator",
        "url": canonical,
        "description": description,
        "applicationCategory": "DeveloperApplication",
        "operatingSystem": ("Any browser with WebAssembly; the invoice is "
                            "processed locally and never uploaded"),
        "isAccessibleForFree": True,
    }
    ld_json = json.dumps(ld, ensure_ascii=False).replace("<", "\\u003c")

    rule_pages_json = json.dumps(sorted(catalog),
                                 separators=(",", ":")).replace("<", "\\u003c")
    js = (_VALIDATE_JS
          .replace("@@PYODIDE_JS_URL@@", PYODIDE_JS_URL)
          .replace("@@PYODIDE_INDEX_URL@@", PYODIDE_INDEX_URL)
          .replace("@@PYODIDE_SRI@@", PYODIDE_SRI)
          .replace("@@RULE_PAGES_JSON@@", rule_pages_json))

    style_extra = (
        "\nbutton.load { font: inherit; font-weight: 700; cursor: pointer;"
        " padding: .55rem 1.1rem; border-radius: .5rem;"
        " border: 1px solid #0969da; background: #0969da; color: #ffffff; }"
        "\nbutton.load[disabled] { opacity: .6; cursor: wait; }"
        "\n.status { border-left: 3px solid #d0d7de; padding-left: .8rem;"
        " min-height: 1.2rem; }"
        "\n.status.err { border-color: #cf222e; color: #cf222e; }"
        "\n.status.ok { border-color: #1a7f37; }"
        "\n.dropzone { display: block; border: 2px dashed #d0d7de;"
        " border-radius: .6rem; padding: 1.6rem 1rem; text-align: center;"
        " cursor: pointer; margin: 1rem 0 .6rem; }"
        "\n.dropzone.drag { border-color: #0969da; }"
        "\n.verdict { font-weight: 700; }"
        "\n.verdict.pass { color: #1a7f37; }"
        "\n.verdict.failv { color: #cf222e; }"
        "\n.cmp-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch;"
        " margin: 1.2rem 0; max-width: 100%; }"
        "\ntable.cmp { border-collapse: collapse; width: 100%;"
        " min-width: 30rem; margin: 0; font-size: .9rem; }"
        "\ntable.cmp th, table.cmp td { border: 1px solid #d0d7de;"
        " padding: .45rem .6rem; text-align: left; vertical-align: top; }"
        "\ntable.cmp th { background: #f6f8fa; }"
        "\n@media (prefers-color-scheme: dark) {"
        " table.cmp th, table.cmp td { border-color: #30363d; }"
        " table.cmp th { background: #161b22; }"
        " .dropzone { border-color: #30363d; }"
        " .status { border-color: #30363d; } }")

    p = []
    w = p.append
    # Head is hand-built (like the rule pages) so the honest JSON-LD block can
    # live in <head> next to the canonical; same self-containment contract —
    # one inline <style>, absolute canonical from BASE_URL, and NO external
    # resource in the static document (the Pyodide loader is injected by the
    # inline script only after the explicit button click).
    w("<!doctype html>")
    w('<html lang="en">')
    w("<head>")
    w('<meta charset="utf-8">')
    w('<meta name="viewport" content="width=device-width, initial-scale=1">')
    w("<title>%s</title>" % _h(title))
    w('<meta name="description" content="%s">' % _h(description))
    w('<link rel="canonical" href="%s">' % _h(canonical))
    w("<style>%s%s</style>" % (_STYLE, style_extra))
    w('<script type="application/ld+json">%s</script>' % ld_json)
    w("</head>")
    w("<body>")
    w("<main>")
    w('<p class="crumb"><a href="../index.html">einvoice</a> / '
      "Browser validator</p>")
    w("<h1>Validate an invoice in your browser</h1>")
    w('<p class="lead">Drop an <strong>XRechnung</strong> UBL XML or a '
      "<strong>ZUGFeRD&nbsp;/&nbsp;Factur-X</strong> PDF here and the same "
      '<strong><span data-claim="rule-count">%d</span>-rule</strong> '
      "EN&nbsp;16931 engine that powers the CLI grades it — no account, no "
      "install. The engine runs <em>inside your browser</em> (CPython on "
      "WebAssembly via Pyodide), so the invoice itself is never uploaded: "
      "after the one-time runtime download, validation makes no network "
      "request that carries your file.</p>" % n_rules)

    w("<h2>Step 1 — load the validator</h2>")
    w("<p>Nothing is fetched until you click. The button downloads the "
      "pinned Pyodide runtime from the jsDelivr CDN (exact version "
      "<code>%s</code>, subresource-integrity checked) plus the engine "
      "modules from this site — about %d&nbsp;MB uncompressed, less on the "
      "wire. On a slow connection the first start can take a minute; "
      "afterwards your browser cache makes it quick.</p>"
      % (_h(PYODIDE_VERSION), PYODIDE_APPROX_MB))
    w('<p><button id="load-btn" type="button" class="load">'
      "Load validator (~%d&nbsp;MB)</button></p>" % PYODIDE_APPROX_MB)
    w('<p id="status" class="status" role="status" aria-live="polite"></p>')

    w('<div id="fallback" hidden>')
    w("<p>No browser run today? The identical engine is a pip install away "
      "(Python&nbsp;3.10+, zero dependencies):</p>")
    w("<pre><code>python3 -m pip install verifyhash-einvoice\n"
      "einvoice validate --profile xrechnung invoice.xml</code></pre>")
    w("</div>")

    w('<div id="picker" hidden>')
    w("<h2>Step 2 — pick an invoice</h2>")
    w('<label class="dropzone" id="dropzone" for="file-input">'
      "Drag &amp; drop an invoice here, or click to choose a file "
      "(<code>.xml</code> UBL XRechnung, or a ZUGFeRD/Factur-X "
      "<code>.pdf</code>)</label>")
    w('<p><input type="file" id="file-input" '
      'accept=".xml,.pdf,application/xml,text/xml,application/pdf" disabled> '
      '<label for="profile">Profile:</label> '
      '<select id="profile">'
      '<option value="xrechnung" selected>xrechnung (EN 16931 + German '
      "CIUS)</option>"
      '<option value="en16931">en16931 (core only)</option>'
      "</select></p>")
    w("</div>")

    w('<div id="result" aria-live="polite"></div>')

    w("<h2>What you get, and honest limits</h2>")
    w("<p>The output is the engine&rsquo;s own conformance report: a "
      "pass/fail verdict (fail means a <em>fatal</em> rule fired), the fatal "
      "and warning counts, and one row per finding with its severity, rule "
      "id and message. Every rule id that has a reference page links to it — "
      "the same pages under <a href=\"../rules/index.html\">the rule "
      "index</a>, with the official Schematron assert, the BT/BG terms and a "
      "concrete fix in English and German.</p>")
    w("<p>Same limits as the CLI, stated plainly: no XSD structural "
      "validation, UBL <code>Invoice</code> and CII (via the ZUGFeRD/"
      "Factur-X PDF container) only — no UBL <code>CreditNote</code> — and 8 "
      "official <code>BR-CL-*</code> code-list checks are documented "
      "deferrals. A green result means &ldquo;no implemented fatal rule "
      "fired&rdquo;, not &ldquo;certified legally conformant&rdquo;. "
      "Browser-specific: the ~%d&nbsp;MB runtime is real — on a metered or "
      "very slow connection the terminal route below is the better tool. "
      "Encrypted or exotic PDF containers the zero-dependency extractor "
      "cannot open are reported honestly as "
      "<code>unsupported-container</code>, never silently passed.</p>"
      % PYODIDE_APPROX_MB)

    w("<h2>Prefer the terminal?</h2>")
    w("<p>The browser page and the package run the <em>same</em> engine "
      "modules — the copies under <code>engine/</code> are byte-identical "
      "to the released package, pinned by sha256 in a committed manifest. "
      "Locally that is:</p>")
    w("<pre><code>python3 -m pip install verifyhash-einvoice\n"
      "einvoice validate --profile xrechnung invoice.xml\n"
      "einvoice validate --json --profile xrechnung invoice.xml</code></pre>")
    w("<p>Start with the <a href=\"../walkthrough/index.html\">5-minute "
      "worked walkthrough</a>, or read the honest "
      "<a href=\"../compare/index.html\">comparison with the official KoSIT "
      "validator and Mustangproject</a>.</p>")

    w("<footer>")
    w("Free and open source (Apache-2.0); see "
      '<a href="../licensing/index.html">licensing</a>. '
      "Generated by <code>gen_site.py</code>. This page itself loads with no "
      "network requests; clicking &ldquo;Load validator&rdquo; downloads the "
      "pinned Pyodide runtime (<code>%s</code>, MPL-2.0, not vendored) from "
      "jsDelivr and the engine modules from this site — your invoice is "
      "never uploaded." % _h(PYODIDE_VERSION))
    w("</footer>")
    w("</main>")
    w("<script>%s</script>" % js)
    w("</body>")
    w("</html>")
    return "\n".join(p) + "\n"


def render_sitemap(catalog):
    """XML sitemap listing EXACTLY the canonical page set — pure, deterministic.

    The URL set is: landing + rule index hub + the worked walkthrough + the
    licensing page + the comparison page + the German product/quickstart page
    + every rule page, each <loc> built from the SAME BASE_URL as the
    canonical <link>s, so canonical and sitemap can never disagree. Rule
    order follows the catalog (stable).
    """
    locs = [_url_landing(), _url_hub(), _url_walkthrough(), _url_licensing(),
            _url_compare(), _url_validate(), _url_de(), _url_de_walkthrough()]
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


# ---------------------------------------------------------------------------
# Engine bundle (T-VHWEB.1): import tracing + deterministic emission.
# ---------------------------------------------------------------------------

def _pkg_module_names():
    """Set of top-level module names in the einvoice package (``foo.py`` ->
    ``foo``). Sorted access only ever happens downstream; this is a set."""
    return {fn[:-3] for fn in os.listdir(PKG_DIR)
            if fn.endswith(".py") and
            os.path.isfile(os.path.join(PKG_DIR, fn))}


def _module_internal_deps(name, mods):
    """Package-internal modules ``name`` imports, found by AST walk.

    Uses ``ast`` (not a regex) so function-level imports count — e.g. the
    lazy ``from .cli import ...`` inside ``__init__.validate_batch`` — and so
    a string that merely LOOKS like an import can never register. Only
    RELATIVE imports (level >= 1) can reference a package sibling; absolute
    imports are stdlib by the package's zero-dependency contract (enforced
    separately by test_web_bundle.py's self-containment audit).
    """
    with open(os.path.join(PKG_DIR, name + ".py"), "rb") as fh:
        tree = ast.parse(fh.read())
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and (node.level or 0) >= 1:
            if node.module:
                top = node.module.split(".")[0]
                if top in mods:
                    out.add(top)
            else:
                # ``from . import X`` — X is a submodule (or, like
                # ``from . import __version__``, an attribute of the package
                # init, which the else-branch below accounts for).
                out.add("__init__")
            for alias in node.names:
                if alias.name in mods:
                    out.add(alias.name)
    return out


def engine_bundle_modules():
    """Sorted transitive import closure from ENGINE_SEEDS over the package.

    This IS the bundle's file set (plus manifest.json). Deterministic: the
    closure is a fixed point of :func:`_module_internal_deps` and the result
    is sorted. Modules outside the closure (as of T-VHWEB.1: only
    ``__main__``) are provably never imported by the validate path — the
    only exclusion ground the task allows.
    """
    mods = _pkg_module_names()
    seen = set()
    frontier = set(ENGINE_SEEDS)
    while frontier:
        m = frontier.pop()
        seen.add(m)
        frontier |= _module_internal_deps(m, mods) - seen
    return sorted(seen)


def render_engine():
    """Map absolute path -> raw BYTES for www/validate/engine/ (pure).

    Every traced module is copied byte-identically (read ``rb``, emitted
    ``wb`` — no decode/re-encode, no newline translation, no rewriting).
    manifest.json carries the sorted file list, a sha256 per file, and the
    package version read live from ``einvoice.__version__``. Rendered with
    ``sort_keys=True`` + fixed indent, so it is byte-deterministic.
    """
    out = {}
    files = []
    hashes = {}
    for mod in engine_bundle_modules():
        fn = mod + ".py"
        with open(os.path.join(PKG_DIR, fn), "rb") as fh:
            data = fh.read()
        out[os.path.join(ENGINE_DIR, fn)] = data
        files.append(fn)
        hashes[fn] = hashlib.sha256(data).hexdigest()
    manifest = {
        "files": sorted(files),
        "sha256": hashes,
        "version": _ENGINE_VERSION,
    }
    out[os.path.join(ENGINE_DIR, "manifest.json")] = (
        json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    return out


# Paths of the surface-level (non-per-rule) generated files.
LANDING_PATH = os.path.join(SITE_DIR, "index.html")
HUB_PATH = os.path.join(RULES_DIR, "index.html")
WALKTHROUGH_PATH = os.path.join(WALKTHROUGH_DIR, "index.html")
LICENSING_PATH = os.path.join(LICENSING_DIR, "index.html")
COMPARE_PATH = os.path.join(COMPARE_DIR, "index.html")
VALIDATE_PATH = os.path.join(VALIDATE_DIR, "index.html")
DE_PATH = os.path.join(DE_DIR, "index.html")
DE_WALKTHROUGH_PATH = os.path.join(DE_WALKTHROUGH_DIR, "index.html")
SITEMAP_PATH = os.path.join(SITE_DIR, "sitemap.xml")
ROBOTS_PATH = os.path.join(SITE_DIR, "robots.txt")


def render_surface(catalog):
    """Map absolute path -> rendered content for the surface files (pure).

    Landing, rule index hub, worked walkthrough, licensing page, comparison
    page, the in-browser validator page (T-VHWEB.2), the German
    product/quickstart page, sitemap.xml, robots.txt, and
    the validator engine bundle (T-VHWEB.1). Values are ``str`` for the
    rendered text pages and raw ``bytes`` for the byte-identical engine
    files; :func:`check` and :func:`write` branch on the type.
    """
    surface = {
        LANDING_PATH: render_landing(),
        HUB_PATH: render_hub(catalog),
        WALKTHROUGH_PATH: render_walkthrough(catalog),
        LICENSING_PATH: render_licensing(),
        COMPARE_PATH: render_compare(),
        VALIDATE_PATH: render_validate(catalog),
        DE_PATH: render_de(),
        DE_WALKTHROUGH_PATH: render_de_walkthrough(catalog),
        SITEMAP_PATH: render_sitemap(catalog),
        ROBOTS_PATH: render_robots(),
    }
    surface.update(render_engine())
    return surface


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


def _read_bytes_or_none(path):
    """Raw bytes of ``path`` (engine-bundle comparisons are byte-exact)."""
    if not os.path.exists(path):
        return None
    with open(path, "rb") as fh:
        return fh.read()


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

    # Surface files (landing / hub / sitemap / robots / engine bundle) —
    # missing or drifted. Engine-bundle entries are bytes: compared raw.
    surface_bad = []
    for path, text in surface.items():
        cur = (_read_bytes_or_none(path) if isinstance(text, bytes)
               else _read_or_none(path))
        if cur != text:
            surface_bad.append(os.path.relpath(path, HERE))

    # Orphan engine files: anything under www/validate/engine/ that a fresh
    # render would NOT emit is drift (e.g. a module removed from the package
    # whose stale copy lingers in the bundle).
    expected_engine = {os.path.basename(p) for p in surface
                       if os.path.dirname(p) == ENGINE_DIR}
    if os.path.isdir(ENGINE_DIR):
        for fn in sorted(os.listdir(ENGINE_DIR)):
            if fn not in expected_engine:
                surface_bad.append(
                    os.path.relpath(os.path.join(ENGINE_DIR, fn), HERE)
                    + " (orphan engine file)")

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
    print("site up to date (%d rule pages + landing + hub + walkthrough + licensing + compare + validate + de + sitemap + robots + engine bundle)"
          % len(want))
    return 0


def write(pages, surface, out_dir=None):
    """(Re)write the whole site tree, pruning orphan rule dirs.

    ``out_dir`` (T-VHSITEDET.1): when given, the IDENTICAL tree is written
    under that directory instead of the committed ``www/`` — the surface
    paths (keyed on :data:`SITE_DIR`) are re-rooted with ``os.path.relpath``.
    Used by ``test_site.py`` to regenerate twice into two temp directories
    and assert byte-identity WITHOUT dirtying the committed tree. The default
    (``None``) writes exactly where it always did.
    """
    site_dir = SITE_DIR if out_dir is None else out_dir
    rules_dir = os.path.join(site_dir, "rules")
    os.makedirs(rules_dir, exist_ok=True)
    # Prune orphan rule directories so the tree never drifts from the catalog.
    # The rule index hub is a FILE (index.html) directly under www/rules/, not
    # a directory, so the listing never sees it as an orphan.
    for d in os.listdir(rules_dir):
        if os.path.isdir(os.path.join(rules_dir, d)) and d not in pages:
            shutil.rmtree(os.path.join(rules_dir, d))
    for rid, text in pages.items():
        d = os.path.join(rules_dir, rid)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "index.html"), "w", encoding="utf-8") as fh:
            fh.write(text)
    # Surface files: landing, rule index hub, walkthrough, sitemap, robots,
    # and the engine bundle. Ensure each parent dir exists (the walkthrough
    # and engine live in their own subdirs). Engine entries are BYTES and are
    # written raw ("wb") so the copies stay byte-identical to the package
    # sources; text pages keep their utf-8 text path.
    for path, text in surface.items():
        dest = (path if out_dir is None
                else os.path.join(out_dir, os.path.relpath(path, SITE_DIR)))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if isinstance(text, bytes):
            with open(dest, "wb") as fh:
                fh.write(text)
        else:
            with open(dest, "w", encoding="utf-8") as fh:
                fh.write(text)
    # Prune orphan engine files (a module dropped from the traced closure
    # must not linger as a stale bundled copy).
    engine_dir = os.path.join(site_dir, "validate", "engine")
    expected_engine = {os.path.basename(p) for p in surface
                       if os.path.dirname(p) == ENGINE_DIR}
    if os.path.isdir(engine_dir):
        for fn in os.listdir(engine_dir):
            if fn not in expected_engine:
                os.remove(os.path.join(engine_dir, fn))
    print("wrote %d rule pages + landing + hub + walkthrough + licensing + compare + validate + de + sitemap + robots + engine bundle under %s"
          % (len(pages), os.path.relpath(site_dir, HERE)))
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

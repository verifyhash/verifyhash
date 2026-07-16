#!/usr/bin/env python3
"""test_a11y.py — accessibility / mobile-quality regression guard over the
static einvoice reference site (``einvoice/www/``).

Every generated page already emits the core primitives that make it accessible
and mobile-friendly: a document-language attribute (``<html lang="en">`` — a
screen-reader / i18n signal), a ``<meta charset="utf-8">`` byte-encoding
declaration, a responsive ``<meta name="viewport" ...>`` tag (a Google
mobile-friendliness ranking signal), and exactly one non-empty ``<h1>`` top
heading (heading-structure signal). No other test asserts these:
``test_site.py`` covers title/description/canonical/JSON-LD/nav/injection and
``test_structured_data.py`` only checks JSON-LD validity.

This guard walks EVERY ``*.html`` under ``www/`` and asserts, per page
independently (the offending path is named in every failure message):

  1. exactly one ``<html lang="en">`` opening tag;
  2. exactly one ``<meta charset="utf-8">``;
  3. exactly one ``<meta name="viewport" content="width=device-width...">``
     (matched permissively on attribute order/spacing);
  4. exactly one ``<h1>...</h1>`` with non-empty visible text (tags/whitespace
     stripped);
  5. exactly one ``<main>`` / ``role="main"`` landmark element;
  6. every ``<img>`` carries a non-empty ``alt`` (a page with no images passes
     trivially);
  7. heading order has no skipped-down levels — the first heading is the
     ``<h1>`` and no heading jumps down more than one level (h1 -> h3 fails);
  8. every ``<a href>`` anchor has discernible text — non-empty visible text or
     a non-empty ``aria-label``/``title`` (decorative anchors are exempt only
     when they carry ``aria-hidden="true"``);
  9. no render-blocking inline ``<script>`` in ``<head>`` — the only ``<script>``
     permitted there is ``type="application/ld+json"`` (JSON-LD data).

So the check cannot pass vacuously, it also asserts the walk found > 100 HTML
files overall and that a set of KNOWN pages each exist and pass — a shape
change that made extraction silently find nothing would FAIL here.

Standard library only; no network. Run from the einvoice dir:

    python3 test_a11y.py
"""

from __future__ import annotations

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WWW_DIR = os.path.join(HERE, "www")

# --- matchers (permissive on attribute order/spacing, strict on presence) ----
# The <html> opening tag carrying lang="en". Kept tolerant of extra attributes
# and casing but requires the language value to be exactly "en".
_HTML_LANG_RE = re.compile(
    r'<html\b[^>]*\blang="en"[^>]*>', re.IGNORECASE)
# <meta charset="utf-8"> — tolerant of surrounding attributes / spacing / case.
_CHARSET_RE = re.compile(
    r'<meta\b[^>]*\bcharset="utf-8"[^>]*>', re.IGNORECASE)
# <meta name="viewport" content="width=device-width..."> — match name=viewport
# permissively (like the _LD_RE approach in test_structured_data.py); the
# content must set the responsive width=device-width, but scale/order is free.
_VIEWPORT_RE = re.compile(
    r'<meta\b[^>]*\bname="viewport"[^>]*\bcontent="[^"]*width=device-width'
    r'[^"]*"[^>]*>',
    re.IGNORECASE)
# Each full <h1>...</h1> element (non-greedy; re.S so it may span lines).
_H1_RE = re.compile(r"<h1\b[^>]*>(.*?)</h1>", re.S | re.IGNORECASE)
# Strip HTML tags to get the visible text of an <h1> body (mirrors the
# tag-strip helper style in test_site.py).
_TAG_RE = re.compile(r"<[^>]*>")

# --- extended matchers (landmark / img / heading-order / link / head-script) -
# The <main> landmark opening tag.
_MAIN_TAG_RE = re.compile(r"<main\b[^>]*>", re.IGNORECASE)
# Any element OTHER than <main> that carries role="main" (an ARIA landmark).
# The negative lookahead keeps a hypothetical <main role="main"> from being
# double-counted as two landmarks.
_ROLE_MAIN_RE = re.compile(
    r'<(?!main\b)[a-zA-Z][a-zA-Z0-9]*\b[^>]*\brole="main"[^>]*>',
    re.IGNORECASE)
# Every <img ...> void element (self-closing or not).
_IMG_RE = re.compile(r"<img\b[^>]*>", re.IGNORECASE)
# The alt="..." attribute value of an <img> (double- or single-quoted).
_ALT_RE = re.compile(r"""\balt\s*=\s*(?:"([^"]*)"|'([^']*)')""", re.IGNORECASE)
# Heading level markers in document order: the digit of each <h1..h6> open tag.
_HLEVEL_RE = re.compile(r"<h([1-6])\b", re.IGNORECASE)
# Each full <a ...>...</a> anchor (attrs, inner text); non-greedy, may span
# lines. Anchors are not legally nested, so non-greedy is correct.
_A_RE = re.compile(r"<a\b([^>]*)>(.*?)</a>", re.S | re.IGNORECASE)
# The <head>...</head> region (there is exactly one; non-greedy).
_HEAD_RE = re.compile(r"<head\b[^>]*>(.*?)</head>", re.S | re.IGNORECASE)
# Each <script ...> opening tag (its attribute string) within a region.
_SCRIPT_OPEN_RE = re.compile(r"<script\b([^>]*)>", re.IGNORECASE)
# type="..." attribute value on a <script> opening tag.
_SCRIPT_TYPE_RE = re.compile(r'\btype\s*=\s*"([^"]*)"', re.IGNORECASE)
# aria-label / title / aria-hidden helpers for anchor discernible-text checks.
_ARIA_LABEL_RE = re.compile(r'\baria-label\s*=\s*"([^"]*)"', re.IGNORECASE)
_TITLE_RE = re.compile(r'\btitle\s*=\s*"([^"]*)"', re.IGNORECASE)
_ARIA_HIDDEN_RE = re.compile(
    r'\baria-hidden\s*=\s*"?true', re.IGNORECASE)
_HREF_RE = re.compile(r"\bhref\s*=", re.IGNORECASE)

# Known pages that MUST exist and pass every check. If any of these is missing
# or fails, extraction is broken or the site regressed — the guard must not
# pass. These are the landing page, the rule hub, the walkthrough, the
# licensing page and one core rule page.
_KNOWN_PAGES = (
    os.path.join("index.html"),
    os.path.join("rules", "index.html"),
    os.path.join("walkthrough", "index.html"),
    os.path.join("licensing", "index.html"),
    os.path.join("rules", "BR-01", "index.html"),
)


def _iter_html_files():
    for root, _dirs, files in os.walk(WWW_DIR):
        for name in sorted(files):
            if name.endswith(".html"):
                yield os.path.join(root, name)


def _visible(text):
    """Visible text of an HTML fragment: tags removed, whitespace collapsed."""
    return _TAG_RE.sub(" ", text).strip()


def check_page(page, rel):
    """Return a list of failure messages for one page (empty == pass)."""
    problems = []

    langs = _HTML_LANG_RE.findall(page)
    if len(langs) != 1:
        problems.append(
            '%s: expected exactly one \'<html lang="en">\' opening tag, '
            "got %d" % (rel, len(langs)))

    charsets = _CHARSET_RE.findall(page)
    if len(charsets) != 1:
        problems.append(
            '%s: expected exactly one \'<meta charset="utf-8">\', got %d'
            % (rel, len(charsets)))

    viewports = _VIEWPORT_RE.findall(page)
    if len(viewports) != 1:
        problems.append(
            '%s: expected exactly one responsive viewport meta '
            '(name="viewport" content="width=device-width..."), got %d'
            % (rel, len(viewports)))

    h1s = _H1_RE.findall(page)
    if len(h1s) != 1:
        problems.append(
            "%s: expected exactly one <h1>...</h1> element, got %d"
            % (rel, len(h1s)))
    else:
        if not _visible(h1s[0]):
            problems.append(
                "%s: the single <h1> has empty visible text" % rel)

    # (1) exactly one <main>/role="main" landmark element.
    landmarks = len(_MAIN_TAG_RE.findall(page)) + len(
        _ROLE_MAIN_RE.findall(page))
    if landmarks != 1:
        problems.append(
            '%s: expected exactly one <main> (or role="main") landmark '
            "element, got %d" % (rel, landmarks))

    # (2) every <img> carries a non-empty alt="". A page with zero <img>
    # passes trivially.
    for img in _IMG_RE.findall(page):
        m = _ALT_RE.search(img)
        alt = (m.group(1) if m and m.group(1) is not None
               else (m.group(2) if m else None))
        if m is None or alt is None or not alt.strip():
            problems.append(
                "%s: <img> without a non-empty alt attribute: %s"
                % (rel, img[:120]))

    # (3) heading order: the first heading must be the <h1>, and no heading may
    # jump DOWN by more than one level (e.g. h1 -> h3 with no h2 between).
    levels = [int(d) for d in _HLEVEL_RE.findall(page)]
    if levels:
        if levels[0] != 1:
            problems.append(
                "%s: first heading in document order is <h%d>, expected <h1>"
                % (rel, levels[0]))
        prev = levels[0]
        for lv in levels[1:]:
            if lv > prev + 1:
                problems.append(
                    "%s: heading order skips a level: <h%d> follows <h%d> "
                    "(full sequence %s)"
                    % (rel, lv, prev, "".join("h%d " % x for x in levels)
                       .strip()))
                break
            prev = lv

    # (4) every <a href=...> anchor has discernible text: non-empty visible
    # text, OR a non-empty aria-label/title. A decorative anchor is exempt only
    # if it carries aria-hidden="true".
    for attrs, inner in _A_RE.findall(page):
        if not _HREF_RE.search(attrs):
            continue
        if _ARIA_HIDDEN_RE.search(attrs):
            continue
        vis = _visible(inner)
        al = _ARIA_LABEL_RE.search(attrs)
        ti = _TITLE_RE.search(attrs)
        has_label = (bool(al) and al.group(1).strip()) or (
            bool(ti) and ti.group(1).strip())
        if not vis and not has_label:
            problems.append(
                "%s: <a href> anchor has no discernible text (empty text and "
                "no aria-label/title): <a%s>%s</a>"
                % (rel, attrs[:80], inner[:60]))

    # (5) no render-blocking inline <script> in <head>: the only <script>
    # permitted there is type="application/ld+json" (JSON-LD data). A script
    # with no type or type="text/javascript" fails.
    head_m = _HEAD_RE.search(page)
    if head_m:
        for sattrs in _SCRIPT_OPEN_RE.findall(head_m.group(1)):
            tm = _SCRIPT_TYPE_RE.search(sattrs)
            stype = tm.group(1).strip().lower() if tm else ""
            if stype != "application/ld+json":
                problems.append(
                    "%s: non-JSON-LD <script%s> in <head> (only "
                    'type="application/ld+json" is permitted there)'
                    % (rel, sattrs[:80]))

    return problems


def _self_test(sample_page, rel):
    """Prove the guard is mutation-sensitive: take a copy of a real page that
    passes, apply each regression in turn, and confirm check_page flags it.

    Operates on an in-memory copy of the page text (a temp copy — never touches
    the committed tree), mirroring test_site.py's tamper simulation. Returns a
    list of failure messages (empty == the guard correctly caught every
    mutation).
    """
    problems = []

    # Sanity: the unmutated sample must pass, else the mutations below prove
    # nothing.
    if check_page(sample_page, rel):
        return ["self-test sample page %s does not pass unmutated — cannot "
                "validate guard sensitivity" % rel]

    mutations = {
        "drop <html lang>": _HTML_LANG_RE.sub("<html>", sample_page, count=1),
        "drop charset meta": _CHARSET_RE.sub("", sample_page, count=1),
        "drop viewport meta": _VIEWPORT_RE.sub("", sample_page, count=1),
        "empty the <h1>": _H1_RE.sub("<h1></h1>", sample_page, count=1),
        "remove the <h1>": _H1_RE.sub("", sample_page, count=1),
        "duplicate the <h1>":
            sample_page.replace("<h1>", "<h1>dup</h1><h1>", 1),
        # (1) landmark: remove and duplicate the <main>.
        "remove the <main>": _MAIN_TAG_RE.sub("", sample_page, count=1),
        "duplicate the <main>":
            _MAIN_TAG_RE.sub(lambda m: m.group(0) + "<main>",
                             sample_page, count=1),
        # (2) img alt: inject an <img> with no alt, and one with empty alt.
        "inject alt-less <img>":
            sample_page.replace("</h1>", '</h1><img src="/x.png">', 1),
        "inject empty-alt <img>":
            sample_page.replace("</h1>", '</h1><img src="/x.png" alt="">', 1),
        # (3) heading order: inject an <h3> right after the <h1> (skips h2).
        "inject skipped heading (h1->h3)":
            _H1_RE.sub(lambda m: m.group(0) + "<h3>skip</h3>",
                       sample_page, count=1),
        # (4) discernible link: inject an empty-text anchor with no label.
        "inject empty-text anchor":
            sample_page.replace("</h1>", '</h1><a href="/x"></a>', 1),
        # (5) head script: inject a plain inline <script> into <head>.
        "inject inline <head> script":
            _HEAD_RE.sub(lambda m: m.group(0).replace(
                ">", "><script>window.x=1;</script>", 1),
                sample_page, count=1),
    }
    for label, mutated in mutations.items():
        if mutated == sample_page:
            problems.append(
                "self-test mutation %r did not change the page (matcher "
                "failed to locate the primitive)" % label)
            continue
        if not check_page(mutated, rel):
            problems.append(
                "self-test: guard did NOT flag mutation %r — it is blind to "
                "that regression" % label)
    return problems


def main():
    if not os.path.isdir(WWW_DIR):
        print("FAIL: www/ directory not found at %s" % WWW_DIR)
        return 1

    total_files = 0
    failures = []

    for path in _iter_html_files():
        total_files += 1
        rel = os.path.relpath(path, HERE)
        with open(path, encoding="utf-8") as fh:
            page = fh.read()
        failures.extend(check_page(page, rel))

    # (anti-vacuous 1) the walk must have found a substantial number of pages.
    if total_files <= 100:
        failures.append(
            "walked only %d HTML files under www/ (expected > 100) — "
            "extraction is broken or the site shrank unexpectedly"
            % total_files)

    # (anti-vacuous 2) each KNOWN page must exist and independently pass.
    for rel in _KNOWN_PAGES:
        path = os.path.join(WWW_DIR, rel)
        if not os.path.exists(path):
            failures.append("known page missing: www/%s" % rel)
            continue
        with open(path, encoding="utf-8") as fh:
            page = fh.read()
        failures.extend(check_page(page, os.path.join("www", rel)))

    # (self-test) prove the guard actually fails on each regression, using an
    # in-memory copy of a known-good page (the landing page). If this page is
    # unreadable the KNOWN-page loop above already failed.
    landing = os.path.join(WWW_DIR, "index.html")
    if os.path.exists(landing):
        with open(landing, encoding="utf-8") as fh:
            failures.extend(_self_test(fh.read(), "www/index.html"))

    if failures:
        sys.stderr.write("A11Y TEST: FAIL (%d)\n" % len(failures))
        for m in failures[:40]:
            sys.stderr.write("  !! " + m + "\n")
        return 1

    print("a11y OK: %d html files under www/; each carries exactly one "
          '<html lang="en">, one <meta charset="utf-8">, one responsive '
          "viewport meta, one non-empty <h1>, one <main>/role=main landmark, "
          "alt on every <img>, gap-free heading order, discernible <a href> "
          'text, and no non-JSON-LD <script> in <head>.' % total_files)
    return 0


if __name__ == "__main__":
    sys.exit(main())

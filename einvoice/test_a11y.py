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
     stripped).

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
          "viewport meta, and one non-empty <h1>." % total_files)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""test_landing.py — landing-page SEO invariants (stdlib only).

Enumerates every landing HTML page under public/ (EXCLUDING the pinned verifier
bundle files: verify-vh-standalone.html and any seal-* files, which must stay
byte-identical and carry their own <title>) and asserts each has:

  * a non-empty <title>,
  * a non-empty <meta name="description" content="...">,

and that titles AND descriptions are UNIQUE across all landing pages. Exits
non-zero (via unittest) on any missing or duplicate title/description.

Run: python3 test_landing.py
"""
import os
import re
import glob
import html
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, "public")

# Files that are NOT landing pages: the pinned, byte-identical verifier bundle.
EXCLUDE_RE = re.compile(r"^(verify-vh-standalone\.html|seal-.*)$")

TITLE_RE = re.compile(r"<title>(.*?)</title>", re.S | re.I)
DESC_RE = re.compile(
    r'<meta\s+name=["\']description["\']\s+content=["\'](.*?)["\']\s*/?>',
    re.S | re.I,
)


def landing_pages():
    """All *.html under public/ (recursive) that are real landing pages."""
    pages = []
    for path in sorted(glob.glob(os.path.join(PUBLIC, "**", "*.html"), recursive=True)):
        if EXCLUDE_RE.match(os.path.basename(path)):
            continue
        pages.append(path)
    return pages


def extract(path):
    with open(path, encoding="utf-8") as fh:
        src = fh.read()
    tm = TITLE_RE.search(src)
    dm = DESC_RE.search(src)
    title = html.unescape(tm.group(1).strip()) if tm else ""
    desc = html.unescape(dm.group(1).strip()) if dm else ""
    return title, desc


class LandingMetadata(unittest.TestCase):
    def setUp(self):
        self.pages = landing_pages()

    def test_pages_exist(self):
        # We must actually be scanning something, or the test is vacuously green.
        self.assertGreaterEqual(
            len(self.pages), 2, "expected at least the homepage + one section page"
        )
        names = {os.path.basename(p) for p in self.pages}
        self.assertIn("index.html", names)

    def test_nonempty_title_and_description(self):
        for path in self.pages:
            rel = os.path.relpath(path, HERE)
            title, desc = extract(path)
            self.assertTrue(title, f"{rel}: missing/empty <title>")
            self.assertTrue(desc, f"{rel}: missing/empty meta description")

    def test_unique_titles(self):
        seen = {}
        for path in self.pages:
            title, _ = extract(path)
            self.assertNotIn(
                title,
                seen,
                f"duplicate <title> {title!r} in {os.path.relpath(path, HERE)} "
                f"and {seen.get(title)}",
            )
            seen[title] = os.path.relpath(path, HERE)

    def test_unique_descriptions(self):
        seen = {}
        for path in self.pages:
            _, desc = extract(path)
            self.assertNotIn(
                desc,
                seen,
                f"duplicate meta description in {os.path.relpath(path, HERE)} "
                f"and {seen.get(desc)}",
            )
            seen[desc] = os.path.relpath(path, HERE)


if __name__ == "__main__":
    unittest.main(verbosity=2)

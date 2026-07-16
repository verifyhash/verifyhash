#!/usr/bin/env python3
"""Offline link-resolution guard for the einvoice product block in the ROOT README.

Extracts every link from the einvoice section of ``README.md`` (the section whose
heading names ``einvoice``) and asserts:

  * every repo-relative link resolves to a file that exists on disk, and
  * every external ``https://`` link is on a small allowlist of known-good targets.

No network is used: external links are checked against a static allowlist, not
fetched. Exits non-zero (raises) on any broken or unexpected link so it can gate CI.

Run:  python3 einvoice/test_readme_einvoice_links.py
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
README = os.path.join(REPO_ROOT, "README.md")

# External https targets the block is allowed to reference (exact match, trailing
# slash significant). Checked offline against this list, never fetched.
EXTERNAL_ALLOWLIST = {
    "https://verifyhash.com/einvoice/",
    "https://verifyhash.com/einvoice/licensing/",
}


def _read_einvoice_section(text):
    """Return the lines of the first '## ...einvoice...' section of the README."""
    lines = text.splitlines()
    start = None
    for i, line in enumerate(lines):
        if line.startswith("## ") and "einvoice" in line.lower():
            start = i
            break
    assert start is not None, "no '## ...einvoice...' section found in README.md"
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if lines[j].startswith("## "):
            end = j
            break
    section = "\n".join(lines[start:end])
    assert start < 60, (
        "einvoice section must begin within the first 60 lines of README.md; "
        "found at line %d" % (start + 1)
    )
    return section


def _extract_links(section):
    """Collect markdown-inline ``[t](target)`` and autolink ``<url>`` targets."""
    links = []
    # [text](target)  — target stops at whitespace or closing paren
    for m in re.finditer(r"\]\(([^)\s]+)\)", section):
        links.append(m.group(1))
    # <https://...> autolinks
    for m in re.finditer(r"<(https?://[^>\s]+)>", section):
        links.append(m.group(1))
    return links


def main():
    with open(README, encoding="utf-8") as fh:
        text = fh.read()
    section = _read_einvoice_section(text)
    links = _extract_links(section)
    assert links, "no links found in the einvoice README section"

    # Required links the acceptance criteria demand are present.
    required = [
        "https://verifyhash.com/einvoice/",
        "einvoice/QUICKSTART.md",
    ]
    for req in required:
        assert req in links, "required link missing from einvoice block: %s" % req
    # A licensing surface must be linked (either the on-disk page or the live URL).
    assert any(
        "licensing" in link for link in links
    ), "einvoice block must link a licensing surface"

    problems = []
    for link in links:
        if link.startswith("http://") or link.startswith("https://"):
            if link not in EXTERNAL_ALLOWLIST:
                problems.append("external link not on allowlist: %s" % link)
        elif link.startswith("#") or link.startswith("mailto:"):
            continue  # in-page anchor / mail link: nothing to resolve offline
        else:
            # repo-relative path (strip any #fragment)
            rel = link.split("#", 1)[0]
            target = os.path.join(REPO_ROOT, rel)
            if not os.path.exists(target):
                problems.append("repo-relative link does not exist on disk: %s" % link)

    if problems:
        for p in problems:
            print("BROKEN LINK: %s" % p, file=sys.stderr)
        raise SystemExit(1)

    print("OK: %d einvoice-block link(s) resolve (%d repo-relative, %d external allowlisted)" % (
        len(links),
        sum(1 for l in links if not l.startswith("http") and not l.startswith("#") and not l.startswith("mailto:")),
        sum(1 for l in links if l.startswith("http")),
    ))


if __name__ == "__main__":
    main()

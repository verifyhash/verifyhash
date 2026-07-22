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

# --- GitHub-Action drift guard (T-VHDIST.4) -------------------------------
# The front-door docs advertise the committed composite Action by in-repo
# path: `uses: verifyhash/verifyhash/einvoice/action@<ref>`. Bind that
# documented path to the committed manifest so a future move/rename of
# einvoice/action/ (or a typo in a doc) fails this gate instead of shipping
# a dead snippet.
ACTION_MANIFEST_RELPATH = os.path.join("einvoice", "action", "action.yml")
ACTION_DOCS = (
    README,                                  # root README einvoice blurb
    os.path.join(HERE, "README.md"),         # einvoice README §4 CI section
    os.path.join(HERE, "QUICKSTART.md"),     # quickstart "Next steps" pointer
)
# owner/repo/<path>@ref — capture <path>; \S+? stops at the mandatory @.
USES_RE = re.compile(r"uses:\s*verifyhash/verifyhash/(\S+?)@")

# External https targets the block is allowed to reference (exact match, trailing
# slash significant). Checked offline against this list, never fetched.
EXTERNAL_ALLOWLIST = {
    "https://verifyhash.com/einvoice/",
    "https://verifyhash.com/einvoice/licensing/",
    "https://verifyhash.com/einvoice/validate/",
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


def _check_action_uses_drift():
    """Assert the committed Action manifest exists and every documented
    `uses: verifyhash/verifyhash/einvoice/action@<ref>` reference in the
    front-door docs points at exactly that committed path."""
    manifest = os.path.join(REPO_ROOT, ACTION_MANIFEST_RELPATH)
    assert os.path.isfile(manifest), (
        "committed Action manifest missing: %s — the docs advertise "
        "`uses: verifyhash/verifyhash/einvoice/action@<ref>`, so einvoice/action/ "
        "may not move or lose action.yml without updating them" % ACTION_MANIFEST_RELPATH
    )

    problems = []
    einvoice_readme_refs = 0
    for doc in ACTION_DOCS:
        if not os.path.isfile(doc):
            problems.append("action-drift: doc missing on disk: %s" % doc)
            continue
        with open(doc, encoding="utf-8") as fh:
            doc_text = fh.read()
        for m in USES_RE.finditer(doc_text):
            path = m.group(1)
            if "einvoice" not in path:
                continue  # e.g. the root README's verifier/action reference
            if path != "einvoice/action":
                problems.append(
                    "action-drift: %s documents uses: path %r but the committed "
                    "Action lives at einvoice/action" % (os.path.basename(doc), path)
                )
            elif not os.path.isfile(os.path.join(REPO_ROOT, path, "action.yml")):
                problems.append(
                    "action-drift: %s documents uses: path %r but %s/action.yml "
                    "does not exist" % (os.path.basename(doc), path, path)
                )
            if doc == os.path.join(HERE, "README.md"):
                einvoice_readme_refs += 1

    # The CI section of einvoice/README.md must actually carry the snippet —
    # silently dropping it would un-surface the Action from the main front door.
    if einvoice_readme_refs == 0:
        problems.append(
            "action-drift: einvoice/README.md no longer documents "
            "`uses: verifyhash/verifyhash/einvoice/action@<ref>`"
        )
    return problems


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
        # T-VHWEB.3: the zero-install path must stay surfaced AND bound to the
        # committed page — the live URL plus the in-repo path (the generic
        # repo-relative pass below asserts that path exists on disk, so a
        # future move of www/validate/index.html breaks this gate).
        "https://verifyhash.com/einvoice/validate/",
        "einvoice/www/validate/index.html",
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

    problems.extend(_check_action_uses_drift())

    if problems:
        for p in problems:
            print("BROKEN LINK: %s" % p, file=sys.stderr)
        raise SystemExit(1)

    print("OK: action uses:-path drift guard green "
          "(documented uses: path == committed einvoice/action/action.yml)")
    print("OK: %d einvoice-block link(s) resolve (%d repo-relative, %d external allowlisted)" % (
        len(links),
        sum(1 for l in links if not l.startswith("http") and not l.startswith("#") and not l.startswith("mailto:")),
        sum(1 for l in links if l.startswith("http")),
    ))


if __name__ == "__main__":
    main()

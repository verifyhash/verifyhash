#!/usr/bin/env python3
"""test_doc_refs_resolvable.py — every adoption pin we document must be a ref a
stranger can actually resolve.

WHY THIS EXISTS. This product advertises three copy-paste entry points: the
PyPI package `verifyhash-einvoice`, the composite GitHub Action, and the
pre-commit hook. Two of three once shipped with references that resolved to
NOTHING:
`rev: v0.1.1` (this repo has never had a git tag — `git ls-remote --tags` is
empty) and a `uses:` naming a standalone `einvoice-action` repo under our own
owner, which has never existed — the Action lives in the `einvoice/action/`
subdirectory of THIS monorepo. A stranger who copy-pasted our own docs got an
error and reasonably concluded the project was abandoned. This guard makes that
class of rot fail loudly at gate time instead of silently in someone else's CI.

WHAT IT ASSERTS (statically, over the doc files listed in DOCS):
  (a) every `rev:` value is a resolvable shape — `main`, a full 40-hex commit
      SHA, or an explicit placeholder — never a `v*`-shaped release tag;
  (b) every `uses:` / `repo:` reference OWNED BY `verifyhash` names a repo that
      exists (only `verifyhash/verifyhash` does) and, when it carries an `@ref`,
      that ref has a resolvable shape by the same rule as (a);
  (c) no file names the phantom repository spelled out in `PHANTOM_REPO` below;
  (d) no file still carries the pre-publication caveat spelled out in
      `STALE_CAVEAT` below (`verifyhash-einvoice` went up on PyPI 2026-07-24);
  (e) the scan is not vacuous — it really saw at least one `rev:` and at least
      one verifyhash-owned `uses:` ref.

THIRD-PARTY REFS ARE IGNORED BY CONSTRUCTION. Only references whose OWNER
segment is `verifyhash` are ref-shape-checked, so `actions/checkout@v4` and
`github/codeql-action/upload-sarif@v3` are correct as written and must stay
that way — this guard never touches them. Local paths (`./third_party/...`) and
`repo: local` are likewise out of scope.

HOW IT RUNS. Plain `python3 test_doc_refs_resolvable.py`, standard library only,
fully offline: it does nothing but `open()` and regex — no network call, no
child process, no package manager. HONEST LIMIT: it therefore cannot tell you
whether a given SHA exists on the remote, only that every ref we document has a
shape that CAN resolve. That is the point — a cheap, deterministic gate, not a
remote liveness probe. Non-zero exit naming each failed check, matching the
convention in `test_precommit_recipe.py`.
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)

#: Files scanned. Paths are relative to this file's directory.
DOCS = (
    "README.md",
    "QUICKSTART.md",
    os.path.join("action", "README.md"),
    os.path.join("ci", "README.md"),
    os.path.join("..", ".pre-commit-hooks.yaml"),
)

#: The GitHub owner whose references we are responsible for. Anything else is a
#: third party we neither control nor police (actions/*, github/*, ...).
OWNER = "verifyhash"

#: The only repository this owner actually has. Kept as an explicit allowlist so
#: inventing a second one (as the phantom Action repo was) fails here.
KNOWN_REPOS = frozenset({"%s/%s" % (OWNER, OWNER)})

# NOTE — the next two constants are ASSEMBLED FROM FRAGMENTS on purpose, and
# must stay that way. The repo-wide gates for this class of rot are literal
# `grep -r` sweeps over `einvoice/`; if this file spelled the banned strings out
# in full, the guard itself would trip its own gate. Do not "simplify" these
# back into single literals.

#: The repository that never existed. Named so the regression is caught even if
#: it reappears in prose rather than inside a `uses:`.
PHANTOM_REPO = OWNER + "/einvoice-" + "action"

#: Caveat that became false when verifyhash-einvoice went up on PyPI.
STALE_CAVEAT = "pending first " + "publish"

#: A ref is resolvable-shaped if it is the branch, a full commit SHA, or an
#: honest placeholder the reader is expected to substitute.
BRANCH_REFS = frozenset({"main"})
PLACEHOLDER_REFS = frozenset({
    "<ref>", "<sha>", "<commit-sha>", "<40-char-sha>", "<full-40-char-sha>",
})
SHA_RE = re.compile(r"\A[0-9a-f]{40}\Z")

REV_RE = re.compile(r"\brev:\s*(\S+)")
USES_RE = re.compile(r"\buses:\s*(\S+)")
REPO_RE = re.compile(r"\brepo:\s*(\S+)")
GITHUB_URL_RE = re.compile(
    r"\Ahttps?://(?:www\.)?github\.com/([^/\s]+)/([^/\s#?]+)")

#: Markup/punctuation that clings to a ref inside markdown prose and code
#: fences (`` `uses: a/b@<ref>` ``, "…@main.", "…@main,"). `<` and `>` are
#: deliberately NOT trimmed — they delimit the honest `<ref>` placeholders.
_TRIM = "`'\"“”‘’,;.()[]{}"

FAILURES = []


def check(cond, msg):
    if cond:
        print("  ok: %s" % msg)
    else:
        print("  FAIL: %s" % msg)
        FAILURES.append(msg)


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def clean(token):
    """Strip markdown decoration from a captured token, keeping <placeholders>."""
    return token.strip().strip(_TRIM)


def ref_is_resolvable(ref):
    """True iff `ref` is a shape a stranger's tooling can actually check out."""
    return (ref in BRANCH_REFS
            or ref in PLACEHOLDER_REFS
            or bool(SHA_RE.match(ref)))


def owner_repo_ref(token):
    """Split a `uses:`/`repo:` token into (owner, repo, ref-or-None).

    Returns None when the token is not an owner/repo reference at all: a local
    path (`./third_party/einvoice/action`), `local`, or stray prose caught by
    the regex (e.g. the literal text ``uses:``-pinnable in a sentence).
    """
    t = clean(token)
    if not t:
        return None

    url = GITHUB_URL_RE.match(t)
    if url:
        repo = url.group(2)
        if repo.endswith(".git"):
            repo = repo[:-len(".git")]
        return url.group(1), repo, None

    if t.startswith((".", "/", "$", "{")) or "://" in t:
        return None            # local path / URL of some other host

    head, sep, ref = t.partition("@")
    parts = head.split("/")
    if len(parts) < 2 or not parts[0] or not parts[1]:
        return None            # not owner/repo shaped
    if not re.match(r"\A[A-Za-z0-9._-]+\Z", parts[0]):
        return None            # prose, not an owner
    return parts[0], parts[1], (ref if sep else None)


def main():
    seen_revs = 0
    seen_owned_refs = 0

    for rel in DOCS:
        path = os.path.join(HERE, rel)
        label = os.path.normpath(rel)
        if not os.path.isfile(path):
            check(False, "%s: documented file exists" % label)
            continue
        text = read(path)

        # (c) + (d) — flat string regressions.
        check(PHANTOM_REPO not in text,
              "%s: does not name the non-existent repo %s" % (label, PHANTOM_REPO))
        check(STALE_CAVEAT not in text,
              "%s: does not claim the package is '%s'" % (label, STALE_CAVEAT))

        # (a) — every rev: value, wherever it appears.
        for raw in REV_RE.findall(text):
            ref = clean(raw)
            seen_revs += 1
            check(ref_is_resolvable(ref),
                  "%s: rev: %r is a resolvable ref (main / 40-hex sha / "
                  "placeholder), not a v*-shaped tag" % (label, ref))

        # (b) — uses:/repo: references we own.
        for raw in USES_RE.findall(text) + REPO_RE.findall(text):
            parsed = owner_repo_ref(raw)
            if parsed is None:
                continue
            owner, repo, ref = parsed
            if owner != OWNER:
                continue       # third party (actions/*, github/*) — not ours
            slug = "%s/%s" % (owner, repo)
            check(slug in KNOWN_REPOS,
                  "%s: reference %r names an existing %s repo (%s)"
                  % (label, clean(raw), OWNER, slug))
            if ref is not None:
                seen_owned_refs += 1
                check(ref_is_resolvable(ref),
                      "%s: %s ref %r is resolvable (main / 40-hex sha / "
                      "placeholder), not a v*-shaped tag" % (label, slug, ref))

    # (e) — the scan must not be vacuously green.
    check(seen_revs > 0, "scan found at least one rev: pin (found %d)" % seen_revs)
    check(seen_owned_refs > 0,
          "scan found at least one %s-owned @ref (found %d)"
          % (OWNER, seen_owned_refs))

    if FAILURES:
        print("\nFAIL: %d check(s) failed" % len(FAILURES))
        sys.exit(1)
    print("\nPASS: every documented %s-owned pin is a resolvable ref "
          "(%d rev: pins, %d @refs across %d files)"
          % (OWNER, seen_revs, seen_owned_refs, len(DOCS)))


if __name__ == "__main__":
    main()

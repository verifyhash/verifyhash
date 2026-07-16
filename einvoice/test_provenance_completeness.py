#!/usr/bin/env python3
"""test_provenance_completeness.py — provenance-completeness / anti-fabrication
guard: every fireable rule's human message is bound to a real vendored source.

Standard library only; no network. Run:

    python3 test_provenance_completeness.py

This is a single anti-fabrication guard over the LIVE fireable id set
``F = einvoice.coverage.engine_fireable_ids()`` (a real registry read, not a
hardcoded list) and the human-facing ``remediation_catalog.json`` rules. It
exists so a genuine gap — a fireable rule with no human message, a provenance
pointer that ties to no vendored artifact, or a fabricated "official" German
string — surfaces as a hard FAILURE instead of being papered over.

The allowed vendored-source set is DERIVED, never guessed: it is exactly the
``schematron_sources`` keys of ``coverage_matrix.json`` whose declared ``file``
artifact actually EXISTS under ``corpus/``. If a catalog ``provenance.source``
is not in that set (or its artifact is missing on disk) the test fails naming
the id and the bad source.

Checks (each a hard assert; mirrors the ACCEPTANCE CRITERIA):

  (a) COMPLETENESS — engine_fireable_ids() and the catalog rules id set are
      EXACTLY equal (symmetric difference empty): no fireable id is missing a
      human message, and no catalog entry is an orphan/dead rule.
  (b) HUMAN MESSAGE — every fireable id's ``title`` and ``fix`` are non-empty
      stripped strings.
  (c) PROVENANCE POINTER — every entry has ``provenance`` with a non-empty
      ``source`` AND a non-empty ``assert`` string, and ``provenance.source``
      is a member of the derived allowed vendored-source set.
  (d) GERMAN HONESTY — every entry's ``de_source`` is one of
      {'kosit','translation'}; every ``de_source=='kosit'`` entry carries a
      non-empty ``message_de`` AND a ``message_de_provenance`` naming an
      ``artifact`` that EXISTS under ``corpus/`` plus a non-empty
      ``assert_id``; NO entry carries ``message_de`` unless
      ``de_source=='kosit'`` (no fabricated verbatim official German).
  (e) NO ORPHAN HAND-AUTHORED MESSAGE — the conjunction of (a)+(c), reported as
      a single machine-readable summary counts line so a real gap is explicit.
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import einvoice.coverage as coverage  # noqa: E402

CATALOG_PATH = os.path.join(HERE, "remediation_catalog.json")
MATRIX_PATH = os.path.join(HERE, "coverage_matrix.json")


def _resolve(path):
    """Resolve a corpus/ artifact path (as stored in the catalog/matrix,
    relative to the einvoice dir) against this test's own directory, so the
    file-existence checks hold regardless of the caller's cwd."""
    if os.path.isabs(path):
        return path
    return os.path.join(HERE, path)


def allowed_sources():
    """The allowed vendored-source set, DERIVED from coverage_matrix.json's
    ``schematron_sources`` — a source key is allowed only if its declared
    artifact file actually exists under corpus/. Returns
    ``(allowed_set, {key: artifact_path})``."""
    with open(MATRIX_PATH, encoding="utf-8") as fh:
        matrix = json.load(fh)
    sources = matrix["schematron_sources"]
    files = {}
    allowed = set()
    missing = []
    for key, meta in sources.items():
        art = meta.get("file")
        files[key] = art
        if art and os.path.exists(_resolve(art)):
            allowed.add(key)
        else:
            missing.append((key, art))
    if missing:
        raise AssertionError(
            "coverage_matrix.json declares schematron_sources whose vendored "
            "artifact is missing on disk (cannot be an allowed provenance "
            "source): "
            + ", ".join("%s -> %r" % (k, a) for k, a in sorted(missing))
        )
    return allowed, files


def _nonempty_str(value):
    return isinstance(value, str) and value.strip() != ""


def main():
    failures = []

    def fail(msg):
        failures.append(msg)

    fireable = coverage.engine_fireable_ids()
    assert isinstance(fireable, set) and fireable, "engine_fireable_ids() empty"

    with open(CATALOG_PATH, encoding="utf-8") as fh:
        catalog = json.load(fh)
    rules = catalog["rules"]
    catalog_ids = set(rules)

    allowed, source_files = allowed_sources()

    # ------------------------------------------------------------------ (a)
    # COMPLETENESS: the two id sets must be EXACTLY equal.
    missing_msg = sorted(fireable - catalog_ids)   # fireable, no catalog entry
    orphan = sorted(catalog_ids - fireable)        # catalog entry, not fireable
    if missing_msg:
        fail("(a) fireable ids with NO remediation_catalog entry (missing "
             "human message): %s" % missing_msg)
    if orphan:
        fail("(a) orphan/dead remediation_catalog entries not in the live "
             "fireable set: %s" % orphan)

    with_provenance = 0
    kosit_de = 0
    translation_de = 0

    for rid in sorted(fireable):
        entry = rules.get(rid)
        if entry is None:
            # already reported under (a); nothing more to check for this id.
            continue

        # -------------------------------------------------------------- (b)
        if not _nonempty_str(entry.get("title")):
            fail("(b) %s has empty/missing title" % rid)
        if not _nonempty_str(entry.get("fix")):
            fail("(b) %s has empty/missing fix" % rid)

        # -------------------------------------------------------------- (c)
        prov = entry.get("provenance")
        if not isinstance(prov, dict):
            fail("(c) %s has no provenance object" % rid)
        else:
            src = prov.get("source")
            if not _nonempty_str(src):
                fail("(c) %s has empty/missing provenance.source" % rid)
            elif src not in allowed:
                fail("(c) %s provenance.source %r ties to NO vendored corpus/ "
                     "artifact (allowed: %s)"
                     % (rid, src, sorted(allowed)))
            else:
                with_provenance += 1
            if not _nonempty_str(prov.get("assert")):
                fail("(c) %s has empty/missing provenance.assert" % rid)

    # -------------------------------------------------------------------- (d)
    # German honesty over EVERY catalog entry (not just fireable — a stray
    # fabricated German string anywhere is a defect).
    for rid in sorted(catalog_ids):
        entry = rules[rid]
        de_source = entry.get("de_source")
        if de_source not in ("kosit", "translation"):
            fail("(d) %s de_source %r not in {'kosit','translation'}"
                 % (rid, de_source))

        has_message_de = _nonempty_str(entry.get("message_de"))

        if de_source == "kosit":
            kosit_de += 1
            if not has_message_de:
                fail("(d) kosit rule %s missing non-empty message_de" % rid)
            mp = entry.get("message_de_provenance")
            if not isinstance(mp, dict):
                fail("(d) kosit rule %s missing message_de_provenance" % rid)
            else:
                art = mp.get("artifact")
                if not _nonempty_str(art):
                    fail("(d) kosit rule %s message_de_provenance.artifact "
                         "empty/missing" % rid)
                elif not os.path.exists(_resolve(art)):
                    fail("(d) kosit rule %s message_de_provenance.artifact %r "
                         "does not exist under corpus/" % (rid, art))
                if not _nonempty_str(mp.get("assert_id")):
                    fail("(d) kosit rule %s message_de_provenance.assert_id "
                         "empty/missing" % rid)
        else:
            if de_source == "translation":
                translation_de += 1
            # No entry may carry an official verbatim German string unless it
            # is provably KoSIT-vendored: message_de is fabricated otherwise.
            if has_message_de:
                fail("(d) %s carries message_de but de_source is %r (not "
                     "'kosit') — fabricated official German" % (rid, de_source))

    # ---------------------------------------------------------- (e) summary
    # Single machine-readable line so a genuine gap surfaces explicitly.
    print("SUMMARY provenance_completeness "
          "fireable=%d catalog=%d with_provenance=%d kosit_de=%d "
          "translation_de=%d allowed_sources=%d symmetric_diff=%d"
          % (len(fireable), len(catalog_ids), with_provenance, kosit_de,
             translation_de, len(allowed),
             len(fireable ^ catalog_ids)))

    if failures:
        print("\nFAIL: %d provenance-completeness violation(s):" % len(failures),
              file=sys.stderr)
        for msg in failures:
            print("  - " + msg, file=sys.stderr)
        return 1

    print("OK: all %d fireable rules bound to a vendored source with an honest "
          "human message and honest German." % len(fireable))
    return 0


if __name__ == "__main__":
    sys.exit(main())

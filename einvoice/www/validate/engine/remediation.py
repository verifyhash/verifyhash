"""Loader for the per-rule remediation catalog (``remediation_catalog.json``).

The catalog is the single machine-readable source of remediation guidance for
every rule the engine can fire (``einvoice.coverage.engine_fireable_ids``): a
short title, what the rule requires, the BT/BG business terms it touches, the
XML location the finding concerns, a one-line fix, the engine-assigned severity
and the Schematron provenance the wording is derived from.

This module is a trivial, side-effect-free reader — standard library only, no
network — so the report writer, RULES.md renderer and ``--explain`` flag can all
consult the same committed data without pulling in the build path. The catalog
DATA is produced by the repo-root ``gen_remediation.py`` build script, which
derives every field from the vendored official Schematron (``corpus/``) plus the
live rule registries; ``test_remediation_catalog.py`` proves the committed file
still matches the engine.
"""

from __future__ import annotations

import json
import os


def default_catalog_path():
    """Path to the committed ``remediation_catalog.json`` next to the package
    (mirrors :func:`einvoice.coverage.default_matrix_path`)."""
    return os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "remediation_catalog.json")


def load_catalog_document(path=None):
    """Parse and return the whole catalog document (metadata + ``rules``)."""
    if path is None:
        path = default_catalog_path()
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def load_catalog(path=None):
    """Return the parsed catalog as a mapping ``rule_id -> entry``.

    ``load_catalog().keys()`` is exactly the set of fireable rule ids; each entry
    is a dict with ``title``, ``requires``, ``bt_bg``, ``location_hint``,
    ``fix``, ``severity`` and ``provenance``.
    """
    return load_catalog_document(path)["rules"]


def entry_for(rule_id, path=None):
    """Remediation entry for a single rule id, or ``None`` if not catalogued."""
    return load_catalog(path).get(rule_id)


#: Human-facing languages the resolver understands. English is always the
#: fallback; German is surfaced only where an OFFICIAL German string exists.
SUPPORTED_LANGS = ("en", "de")


def official_message(rule_id, lang, catalog=None, path=None):
    """The official human-facing message for ``rule_id`` in ``lang``, or ``None``.

    ``lang == "de"`` returns the catalog's ``message_de`` — the vendored KoSIT
    XRechnung ``<sch:assert>`` text VERBATIM — but ONLY for the BR-DE-family
    rules that actually carry one (de_source == "kosit"); every other rule, and
    every non-German ``lang``, returns ``None`` so the caller keeps its existing
    (English) message. Nothing is translated here: this is pure lookup of a
    string already lifted from disk by ``gen_remediation.py``.

    ``catalog`` may be a preloaded ``rule_id -> entry`` mapping (avoids re-reading
    the JSON per violation); otherwise the committed catalog is loaded.
    """
    if lang == "de":
        entry = (catalog or load_catalog(path)).get(rule_id)
        if entry is not None:
            return entry.get("message_de")
    return None


def resolve_message(rule_id, english_message, lang="en", catalog=None, path=None):
    """Return the message to show a human for ``rule_id`` in ``lang``.

    Returns the official German ``message_de`` where one exists under
    ``lang == "de"``, otherwise the ``english_message`` passed in (a clean
    fallback). Rule ids, severities and which rules fire are never affected —
    this only chooses the display string.
    """
    return official_message(rule_id, lang, catalog=catalog, path=path) or english_message

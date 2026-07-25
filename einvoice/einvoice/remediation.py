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


#: Basename of the catalog file, shared by both resolution candidates below.
_CATALOG_NAME = "remediation_catalog.json"


def default_catalog_path():
    """Path to the committed ``remediation_catalog.json``.

    Two candidates, in this precedence order (same idea as
    ``cli._packaged_attestation()`` winning over ``cli._artifact_json()``):

    1. the PACKAGED copy that ships in the wheel as package-data, sitting right
       next to this module (``einvoice/remediation_catalog.json``);
    2. the repo-root-adjacent copy next to the package dir, which is what a
       source checkout has always used (and which ``gen_remediation.py`` writes
       first).

    The packaged copy comes first because it is the ONLY one an installed wheel
    has: ``packages=["einvoice"]`` ships the package dir alone, so in a
    ``pip install`` context candidate 2 does not exist and every report record's
    ``title``/``fix_hint``/``location`` would come back null. In a source
    checkout both exist and are byte-identical by construction —
    ``gen_remediation.main()`` writes them from one serialized string and
    ``test_remediation_catalog.py`` asserts it — so the precedence cannot change
    what any caller reads.

    Falls through to the repo-root path when neither file is present, so the
    error a caller sees is the familiar ``FileNotFoundError`` on the canonical
    location rather than a confusing packaged-path one. Stdlib only, no I/O
    beyond two ``os.path.exists`` probes, no side effects.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    packaged = os.path.join(here, _CATALOG_NAME)
    if os.path.exists(packaged):
        return packaged
    return os.path.join(os.path.dirname(here), _CATALOG_NAME)


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


#: Process-wide cache of the committed catalog (``rule_id -> entry``), loaded
#: at most once. Shared by every relay surface (``einvoice.report``'s record
#: writer and ``einvoice.validate.Result.to_dict``) so a large batch parses the
#: JSON exactly once instead of per violation.
_CATALOG_CACHE = None


def cached_catalog():
    """Return the cached remediation catalog mapping (loaded at most once).

    On any failure to read/parse the committed catalog this degrades to an
    EMPTY mapping, so enrichment falls back to null/empty fields rather than
    raising — no surface may fail (or change a verdict) because remediation
    data is missing. That is not hypothetical: verifyhash-einvoice 0.4.2
    shipped a wheel WITHOUT the packaged catalog, and every unguarded
    ``load_catalog()`` call became a ``FileNotFoundError`` traceback in the
    user's CI (see ``test_wheel_remediation.WheelWithoutCatalog``).
    """
    global _CATALOG_CACHE
    if _CATALOG_CACHE is None:
        try:
            _CATALOG_CACHE = load_catalog()
        except (OSError, ValueError, KeyError):
            _CATALOG_CACHE = {}
    return _CATALOG_CACHE


#: The four catalog-relayed remediation keys, in emission order. Consumers may
#: rely on all four being PRESENT on every violation record of every machine
#: surface; an uncatalogued rule id yields null/empty values, never absence.
REMEDIATION_KEYS = ("title", "fix_hint", "terms", "location")


def remediation_fields(rule_id, catalog=None):
    """The four remediation fields for ``rule_id``, as a fresh ordered dict.

    THE single relay from the committed catalog into a machine record. Both
    ``einvoice.report._record`` (``--format json`` and friends) and
    ``einvoice.validate.Result._violation_dict`` (``validate --json`` /
    ``validate-batch --json``) call this one helper, so the two surfaces cannot
    drift into disagreeing remediation values for the same rule id. It authors
    no wording of its own: ``title``/``fix``/``bt_bg``/``location_hint`` come
    verbatim from the Schematron-traceable catalog that ``gen_remediation.py``
    builds and ``test_remediation_catalog.py`` pins.

    A rule id with no catalog entry degrades to ``{"title": None, "fix_hint":
    None, "terms": [], "location": None}`` — every key present, never a
    ``KeyError`` and never a missing key, so a consumer can index the shape
    unconditionally.

    :param catalog: optional pre-loaded ``rule_id -> entry`` mapping (a caller
        projecting a whole result passes it once); when omitted, the cached
        module catalog is used.
    """
    if catalog is None:
        catalog = cached_catalog()
    entry = catalog.get(rule_id) or {}
    return {
        "title": entry.get("title"),
        "fix_hint": entry.get("fix"),
        "terms": list(entry.get("bt_bg") or []),
        "location": entry.get("location_hint"),
    }


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

    An installation whose catalog file is MISSING or unreadable degrades to
    ``None`` — i.e. the caller keeps its English message — exactly as an
    uncatalogued rule id does. This is the ``report._remediation_catalog()``
    discipline applied to the CLI's ``--lang de`` path (T-VHWHEEL.2): MEASURED
    on a catalog-less wheel image, ``einvoice validate <valid-path> --lang de``
    let a ``FileNotFoundError`` escape into ``cli.py``'s OSError arm, which
    reported ``error: cannot read <invoice>: No such file or directory`` and
    exit 2 — blaming an invoice file that plainly exists, for a run that had
    already validated it. A missing translation must never change a verdict.
    """
    if lang == "de":
        if catalog is None:
            try:
                catalog = load_catalog(path)
            except (OSError, ValueError, KeyError):
                return None
        entry = catalog.get(rule_id)
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

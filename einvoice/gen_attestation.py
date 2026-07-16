#!/usr/bin/env python3
"""Generate a byte-reproducible conformance-CLAIM attestation.

Where ``einvoice/receipt.py`` attests the outcome of validating ONE invoice,
this generator attests the TOOL's OWN published conformance claim, so a
skeptical procurement evaluator can independently confirm that the rule set,
the coverage headline, the test-suite pass rates, and the pinned corpus content
hashes have not drifted since publication.

It reads four already-committed, already-drift-guarded source artifacts and
copies (never re-derives-approximately) the numbers out of them:

    * ``export/rules.json``            -- rule set + rule counts
                                          (drift-guarded by test_export.py)
    * ``export/coverage.json``         -- frozen coverage headline
                                          (drift-guarded by test_export.py)
    * ``testsuite_conformance.json``   -- in-scope UBL + CII pass rates
                                          (drift-guarded by
                                          test_testsuite_conformance.py)
    * ``sbom/bom.json``                -- the SHA-256 already pinned for every
                                          vendored corpus tree by gen_sbom.py
                                          (drift-guarded by test_sbom.py)

The corpus hashes are taken verbatim from the SBOM -- there is deliberately NO
second hashing path in this generator; the SBOM is the single source of the
pinned corpus digests. (The *verify* path additionally re-walks the live corpus
tree with gen_sbom's own ``corpus_sha256`` and confirms it still equals those
pinned digests, so the attestation binds to the real bytes on disk, not merely
to a copied number.)

The emitted ``attestation.json`` is
``{"attestation": <body>, "content_sha256": <hex>}`` where ``content_sha256``
is the SHA-256 of the canonicalized body. Canonical form is identical to
receipt.py: ``json.dumps(obj, sort_keys=True, separators=(",", ":"))``
(UTF-8 encoded).

DETERMINISM IS THE PRODUCT. There is NO wall-clock timestamp in the hashed
body: the same source artifacts always yield a byte-identical attestation and
an identical content hash, on every run and every machine. That is exactly what
lets a third party recompute it and compare.

Standard library only (``hashlib``, ``json``) -- zero new runtime dependency.
"""

from __future__ import annotations

import collections
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent

RULES_PATH = HERE / "export" / "rules.json"
COVERAGE_PATH = HERE / "export" / "coverage.json"
TESTSUITE_PATH = HERE / "testsuite_conformance.json"
BOM_PATH = HERE / "sbom" / "bom.json"
ATTESTATION_PATH = HERE / "attestation.json"

#: Version of the attestation format itself (bump only on a breaking layout
#: change), so a consumer can tell how to read an older attestation.
ATTESTATION_FORMAT = "einvoice-conformance-attestation/1"


def canonical_json(obj):
    """Canonical serialization used for hashing AND for the file on disk.

    Byte-identical to receipt.py's ``canonical_json``: keys sorted, no
    insignificant whitespace. Returns a ``str`` (UTF-8 when encoded).
    """
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _sha256_hex(data):
    """Lowercase hex SHA-256 of ``data`` (bytes)."""
    return hashlib.sha256(data).hexdigest()


def _load(path):
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _rules_section(rules):
    """Rule-set id(s) + counts, copied from export/rules.json.

    ``count`` is the artifact's own ``rule_count`` field (the same number
    test_export.py pins). ``by_family`` is a deterministic tally of the rule
    records by their ``family`` tag, and ``rulesets`` is the sorted set of
    binding ``source`` ids (e.g. ``en16931-ubl``, ``xrechnung-cii``) that the
    rules bind to -- the machine ids of the rule sets under attestation.
    """
    records = rules["rules"]
    by_family = collections.Counter(r["family"] for r in records)
    rulesets = set()
    for r in records:
        for binding in r.get("bindings", {}).values():
            source = binding.get("source")
            if source:
                rulesets.add(source)
    return {
        "count": rules["rule_count"],
        # sort_keys in canonical_json orders the dict; still build it plainly.
        "by_family": dict(sorted(by_family.items())),
        "rulesets": sorted(rulesets),
    }


def _coverage_section(coverage):
    """Frozen coverage headline, copied verbatim from export/coverage.json.

    The two syntax-binding fractions (UBL 741/756, CII 546/583 as they stand
    in the artifact) and the asserted business-rule total are copied, never
    recomputed-approximately.
    """
    sb = coverage["syntax_binding"]
    return {
        "business_rules_total_asserted": (
            coverage["business_rules"]["total_asserted"]
        ),
        "syntax_binding": {
            "ubl": {
                "proven": sb["ubl"]["proven"],
                "total": sb["ubl"]["total"],
            },
            "cii": {
                "proven": sb["cii"]["proven"],
                "total": sb["cii"]["total"],
            },
        },
    }


def _testsuite_section(testsuite):
    """In-scope UBL + CII pass rates from testsuite_conformance.json.

    Uses the same ``summary`` tallies that test_testsuite_conformance.py
    asserts against a live re-classification (in_scope_*_accepted / _total).
    """
    s = testsuite["summary"]
    return {
        "ubl": {
            "accepted": s["in_scope_ubl_accepted"],
            "total": s["in_scope_ubl_total"],
        },
        "cii": {
            "accepted": s["in_scope_cii_accepted"],
            "total": s["in_scope_cii_total"],
        },
    }


def _corpus_section(bom):
    """Pinned SHA-256 of every vendored corpus artifact, from sbom/bom.json.

    Reuses the SBOM's already-pinned digests (produced by gen_sbom.py's
    ``corpus_sha256`` over each vendored tree). No second hashing path here.
    Emitted sorted by corpus path so the list order is deterministic.
    """
    entries = []
    for comp in bom.get("components", []):
        # Only the vendored-corpus data components carry a corpus-path
        # property and a SHA-256 hash; library components (if any) do not.
        props = {p["name"]: p["value"] for p in comp.get("properties", [])}
        corpus_path = props.get("verifyhash:corpus-path")
        if corpus_path is None:
            continue
        sha256 = None
        for h in comp.get("hashes", []):
            if h.get("alg") == "SHA-256":
                sha256 = h.get("content")
                break
        if sha256 is None:
            raise SystemExit(
                "gen_attestation: corpus component %r has no SHA-256 hash "
                "in sbom/bom.json" % comp.get("bom-ref")
            )
        entries.append({
            "name": comp.get("name"),
            "version": comp.get("version"),
            "path": corpus_path,
            "sha256": sha256,
        })
    if not entries:
        raise SystemExit(
            "gen_attestation: sbom/bom.json declared no vendored corpus "
            "components -- refusing to emit an empty corpus attestation"
        )
    entries.sort(key=lambda e: e["path"])
    return entries


def build_attestation():
    """Return the full attestation dict, deterministically, from source files.

    ``{"attestation": <body>, "content_sha256": <hex>}`` where
    ``content_sha256`` is the SHA-256 of the canonicalized body. No timestamp;
    identical source artifacts always produce a byte-identical result.
    """
    rules = _load(RULES_PATH)
    coverage = _load(COVERAGE_PATH)
    testsuite = _load(TESTSUITE_PATH)
    bom = _load(BOM_PATH)

    body = {
        "format": ATTESTATION_FORMAT,
        "rules": _rules_section(rules),
        "coverage": _coverage_section(coverage),
        "testsuite_conformance": _testsuite_section(testsuite),
        "corpus": _corpus_section(bom),
    }
    content_sha256 = _sha256_hex(canonical_json(body).encode("utf-8"))
    return {"attestation": body, "content_sha256": content_sha256}


def attestation_json():
    """Canonical JSON text (with trailing newline) of the attestation."""
    return canonical_json(build_attestation()) + "\n"


def main(argv=None):
    text = attestation_json()
    with ATTESTATION_PATH.open("w", encoding="utf-8") as fh:
        fh.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

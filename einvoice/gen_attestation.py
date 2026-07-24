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
import os
from pathlib import Path

import gen_sbom

HERE = Path(__file__).resolve().parent

RULES_PATH = HERE / "export" / "rules.json"
COVERAGE_PATH = HERE / "export" / "coverage.json"
TESTSUITE_PATH = HERE / "testsuite_conformance.json"
BOM_PATH = HERE / "sbom" / "bom.json"
ATTESTATION_PATH = HERE / "attestation.json"
#: Second, byte-identical copy shipped INSIDE the ``einvoice`` package so it
#: lands in the wheel as package-data (see pyproject.toml). A `pip install`
#: evaluator then receives the conformance-CLAIM attestation with the artifact
#: itself. main() writes BOTH from the SAME serialized bytes, so the source-tree
#: copy and the packaged copy can never drift apart; test_attestation.py asserts
#: their byte-identity.
PACKAGE_ATTESTATION_PATH = HERE / "einvoice" / "attestation.json"

#: Version of the attestation format itself (bump only on a breaking layout
#: change), so a consumer can tell how to read an older attestation.
ATTESTATION_FORMAT = "einvoice-conformance-attestation/1"

#: Committed GENERATED TRUST artifacts that are bound by a raw-bytes SHA-256 in
#: the ``artifacts`` section below. Each is a machine-readable conformance claim
#: (an API contract, a CII-parity ledger, a known-open audit, a coverage matrix,
#: a syntax-binding catalog, a remediation catalog) that a procurement evaluator
#: could quote -- so the attestation pins the exact bytes and verify fails on any
#: drift. Paths are RELATIVE to this directory. Keep sorted for readability; the
#: emitted section is keyed by path and canonical_json sorts it regardless.
TRUST_ARTIFACTS = [
    "api_contract.json",
    "cii_parity.json",
    "coverage_matrix.json",
    "known_open_audit.json",
    "remediation_catalog.json",
    "syntax_binding_catalog.json",
]

#: Generated trust artifacts that ARE bound, but by a DEDICATED body section
#: (their meaningful numbers -- and for the corpus, their on-disk bytes -- are
#: recomputed by verify_attestation.py), not by the generic raw-bytes ``artifacts``
#: section. Recorded here (path -> which section binds it) so the completeness
#: guard in test_attestation.py knows they are accounted for without hashing them
#: twice. ``attestation.json`` is the document itself and cannot hash itself.
BOUND_ELSEWHERE = {
    "export/rules.json": "rules section (rule counts / families / rulesets)",
    "export/coverage.json": "coverage section (syntax-binding + BR totals)",
    "testsuite_conformance.json": "testsuite_conformance section (pass rates)",
    "sbom/bom.json": "corpus section (per-corpus pinned + re-walked SHA-256)",
    "attestation.json": "the attestation document itself (self-referential)",
    "einvoice/attestation.json": (
        "byte-identical wheel package-data copy of the attestation document "
        "(same bytes as attestation.json; asserted equal in test_attestation.py)"
    ),
    "einvoice/remediation_catalog.json": (
        "byte-identical wheel package-data copy of remediation_catalog.json, "
        "which is itself hashed once in TRUST_ARTIFACTS above (asserted equal "
        "in test_remediation_catalog.py)"
    ),
}

#: Generator outputs that are deliberately NOT hash-bound because they are not
#: machine trust claims. Each entry carries a one-line reason. Path/pattern keys
#: mirror test_determinism.GENERATORS output patterns exactly, so the
#: completeness guard can prove every generator output is either bound or exempt.
EXEMPT = {
    "COVERAGE.md": "human-readable coverage doc, not a machine trust claim",
    "einvoice/RULES.md": "human-readable rules doc, not a machine trust claim",
    "examples/*/report.json": (
        "per-example demo validation report (illustrative output of the "
        "validator); the tool's conformance CLAIM is bound above"
    ),
    "www/index.html": "static reference-site page, not a machine trust claim",
    "www/robots.txt": "static site crawler directive, not a trust claim",
    "www/sitemap.xml": "static site URL index, not a trust claim",
    "www/rules/index.html": "static rules hub page, not a trust claim",
    "www/rules/*/index.html": "static per-rule reference page, not a trust claim",
    "www/walkthrough/index.html": "static walkthrough page, not a trust claim",
    "www/licensing/index.html": "static licensing page, not a trust claim",
    "www/de/index.html": "static German product page, not a trust claim",
    "corpus/vendored/syntax-binding/sb-viol-*_ubl.xml": (
        "synthesized syntax-binding UBL test fixture (XML input), not a claim"
    ),
    "fixtures/sb-pass-clean_cii.xml": (
        "synthesized clean CII test fixture (XML input), not a claim"
    ),
    "fixtures/sb-viol-*_cii.xml": (
        "synthesized syntax-binding CII violation fixture (XML input), not a claim"
    ),
}


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

    The two syntax-binding fractions (UBL 741/756, CII 554/583 as they stand
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


def _package_section():
    """Identity of the PUBLISHED distribution this attestation speaks for.

    Sourced from ``pyproject.toml`` -- the single source of truth for the
    package name and version -- via ``gen_sbom.read_metadata`` (the SAME reader
    ``build_sbom`` uses), so the attestation's package identity can never drift
    from the SBOM's. The purl is derived byte-identically to
    ``gen_sbom.build_sbom`` (``pkg:pypi/{name}@{version}``). ``distribution`` is
    the honest published-status literal ``"pypi"``: ``verifyhash-einvoice`` has
    been live on PyPI since 0.2.0 (see PROVENANCE.md / REPUBLISH-PYPI.md).

    Deterministic and timestamp-free: a fixed pyproject always yields the same
    section, so the whole attestation stays byte-reproducible.
    """
    name, version, _ = gen_sbom.read_metadata()
    purl = "pkg:pypi/{}@{}".format(name, version)
    return {
        "name": name,
        "version": version,
        "purl": purl,
        "distribution": "pypi",
    }


def _artifacts_section():
    """Raw-bytes SHA-256 of every committed GENERATED TRUST artifact.

    Each digest is computed over the EXACT committed bytes of the live file (via
    the module's own ``_sha256_hex`` -- no second hashing path, no reparse, no
    approximation), so verify_attestation.py's recompute-and-compare catches any
    drift in these machine trust claims. Keyed by repo-relative path; the mapping
    is a pure function of the committed files, hence byte-reproducible.
    """
    out = {}
    for rel in TRUST_ARTIFACTS:
        path = HERE / rel
        if not path.is_file():
            raise SystemExit(
                "gen_attestation: trust artifact %r is missing at %s -- refusing "
                "to emit an attestation with an unbound trust claim" % (rel, path)
            )
        out[rel] = _sha256_hex(path.read_bytes())
    return out


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
        "package": _package_section(),
        "rules": _rules_section(rules),
        "coverage": _coverage_section(coverage),
        "testsuite_conformance": _testsuite_section(testsuite),
        "corpus": _corpus_section(bom),
        "artifacts": _artifacts_section(),
    }
    content_sha256 = _sha256_hex(canonical_json(body).encode("utf-8"))
    return {"attestation": body, "content_sha256": content_sha256}


def attestation_json():
    """Canonical JSON text (with trailing newline) of the attestation."""
    return canonical_json(build_attestation()) + "\n"


def _atomic_write_text(path, text):
    """Write ``text`` (UTF-8) to ``path`` atomically via a temp file + rename.

    A partial/interrupted write can never leave a half-written attestation on
    disk, and because both copies are written from the SAME ``text`` string the
    source-tree and packaged attestations are byte-identical by construction.
    """
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(str(tmp), str(path))


def main(argv=None):
    text = attestation_json()
    # Write BOTH copies from the SAME serialized bytes so einvoice/attestation.json
    # (source tree) and einvoice/einvoice/attestation.json (wheel package-data)
    # can NEVER diverge. The packaged copy is what a `pip install` evaluator
    # receives; test_attestation.py asserts the two stay byte-identical.
    _atomic_write_text(ATTESTATION_PATH, text)
    _atomic_write_text(PACKAGE_ATTESTATION_PATH, text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

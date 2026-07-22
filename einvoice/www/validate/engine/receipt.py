"""Deterministic EN 16931 / XRechnung conformance receipts.

A *conformance receipt* is a small, canonical, byte-stable JSON document that
attests the outcome of validating one invoice. It is the bridge between the
einvoice validator and verifyhash's tamper-evidence thesis: because the receipt
is fully deterministic, two parties can re-run the validation and get a
byte-identical receipt with an identical content hash — so a receipt can be
anchored / compared without trusting the party that produced it.

What the receipt attests (the "body"):

    * ``tool``               the validator name and version (the version is the
                             package's single source of truth, ``__version__`` —
                             never a second hardcoded copy).
    * ``profile``            the rule-set id used (``en16931`` core, or
                             ``xrechnung`` = core + the German BR-DE-* CIUS).
    * ``verdict``            ``PASS`` iff no *fatal* rule failed, else ``FAIL``
                             (the official Schematron ``flag`` semantics: only
                             fatal violations invalidate a document).
    * ``well_formed``        whether the input parsed as well-formed XML.
    * ``failed_fatal_rules`` the fatal rule ids that failed, each with its
                             message, taken from ``Result.to_dict()`` in rule
                             evaluation order.
    * ``input_sha256``       SHA-256 of the input document's raw bytes.

The emitted document wraps that body together with ``content_sha256`` — the
SHA-256 of the *canonicalized* body. Canonical form is
``json.dumps(..., sort_keys=True, separators=(",", ":"))`` (UTF-8 encoded).

DETERMINISM IS THE PRODUCT. Identical input bytes + identical profile always
yield a byte-identical receipt and an identical content hash, on every run and
regardless of the file's path or the current time. There is no wall-clock
timestamp unless a caller passes ``issued_at`` explicitly — and when they do,
it becomes part of the hashed body (a different timestamp is, honestly, a
different receipt).

Standard library only (``hashlib``, ``json``).
"""

from __future__ import annotations

import hashlib
import json

from . import __version__
from .parser import NotWellFormed
from .validate import validate_file

#: Import-package / console-script name. The tool's identity in the receipt.
TOOL_NAME = "einvoice"

#: Version of the *receipt format itself* (bump only on a breaking layout
#: change), so a consumer can tell how to read an older receipt.
RECEIPT_FORMAT = "einvoice-conformance-receipt/1"

# Well-formedness failures are reported under the same id the CLI already uses
# (``cli.py`` prints "S-WF: input is not well-formed XML").
_WF_RULE_ID = "S-WF"


def canonical_json(obj):
    """Canonical serialization used for hashing AND for CLI output.

    Deterministic by construction: keys sorted, no insignificant whitespace.
    Returns a ``str`` (UTF-8 when encoded).
    """
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _sha256_hex(data):
    """Lowercase hex SHA-256 of ``data`` (bytes)."""
    return hashlib.sha256(data).hexdigest()


def build_receipt(path, profile="en16931", issued_at=None):
    """Validate ``path`` and return the full conformance-receipt dict.

    The returned dict is ``{"receipt": <body>, "content_sha256": <hex>}`` where
    ``content_sha256`` is the SHA-256 of the canonicalized ``body``. Reads the
    file's raw bytes for ``input_sha256`` and re-parses them through the normal
    validator, so a not-well-formed input yields a ``FAIL`` receipt (with an
    ``S-WF`` entry) rather than an exception — the receipt is still emitted.

    ``issued_at`` is optional and, when given, is copied verbatim into the
    hashed body. When ``None`` (the default) the receipt carries no timestamp
    and is fully deterministic.
    """
    with open(path, "rb") as fh:
        raw = fh.read()
    input_sha256 = _sha256_hex(raw)

    try:
        result = validate_file(path, profile=profile)
    except NotWellFormed as exc:
        well_formed = False
        verdict = "FAIL"
        failed_fatal = [{
            "rule": _WF_RULE_ID,
            "message": "input is not well-formed XML: %s" % exc,
        }]
    else:
        well_formed = True
        verdict = "PASS" if result.ok else "FAIL"
        # Fatal rule ids (with messages) straight from Result.to_dict(), in the
        # validator's deterministic rule-evaluation order.
        failed_fatal = [
            {"rule": v["rule"], "message": v["message"]}
            for v in result.to_dict()["violations"]
            if v["severity"] == "fatal"
        ]

    body = {
        "format": RECEIPT_FORMAT,
        "tool": {"name": TOOL_NAME, "version": __version__},
        "profile": profile,
        "well_formed": well_formed,
        "verdict": verdict,
        "input_sha256": input_sha256,
        "failed_fatal_rules": failed_fatal,
    }
    if issued_at is not None:
        body["issued_at"] = issued_at

    content_sha256 = _sha256_hex(canonical_json(body).encode("utf-8"))
    return {"receipt": body, "content_sha256": content_sha256}


def receipt_json(path, profile="en16931", issued_at=None):
    """Return the canonical JSON text of the receipt for ``path``.

    Byte-stable: identical input bytes + profile (+ ``issued_at``) always
    produce the exact same string.
    """
    return canonical_json(build_receipt(path, profile=profile, issued_at=issued_at))

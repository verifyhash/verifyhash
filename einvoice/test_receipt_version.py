#!/usr/bin/env python3
"""test_receipt_version.py — bind RECEIPT_FORMAT to the receipt's real shape.

The conformance receipt already carries a *structure-version* marker distinct
from the tool version: the top-level ``format`` field, whose value is the module
constant ``RECEIPT_FORMAT`` (``einvoice-conformance-receipt/1``). The ``/N``
suffix is the CANONICAL-STRUCTURE version — bump it (``/2``, ``/3`` …) only when
the receipt's layout changes in a way an older consumer could misread.

test_receipt.py already pins the *tool* version single-source (``tool.version``
== ``einvoice.__version__``) and the golden snapshots pin exact receipt BYTES.
What nothing guards is the link between the ``/N`` marker and the shape it
names: the golden byte-snapshots would go red on a structural change, but a
developer who deliberately regenerates the goldens for that change is not forced
to BUMP the version marker. Then two structurally different receipts would both
claim ``/1`` and a consumer keyed on ``format`` is silently misled.

This suite closes that gap, mirroring the report_version discipline:

  (1) FORMAT IS EMITTED — a freshly built receipt's ``format`` field equals the
      ``RECEIPT_FORMAT`` symbol exactly (not a hardcoded string copy).
  (2) SHAPE IS PINNED PER VERSION — the sorted set of key PATHS of a
      ``build_receipt`` document (top-level + nested, incl. list-element keys)
      is frozen per structure-version in ``SHAPE_BY_VERSION``. The test parses
      the integer ``N`` out of ``RECEIPT_FORMAT`` and asserts the ACTUAL shape
      equals the shape registered for ``N``. So a structural change that is not
      accompanied by a ``RECEIPT_FORMAT`` bump (and a matching new shape entry)
      fails HERE with a message telling the developer exactly what to do.

Standard library only. Fast: two validations over committed corpus invoices.
"""

import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.receipt import (                                     # noqa: E402
    build_receipt, receipt_json, RECEIPT_FORMAT,
)

# Committed corpus invoices exercised through the REAL build path. The FAIL
# invoice is used to pin the shape because it populates ``failed_fatal_rules``
# with at least one entry, so the nested per-rule keys (``rule``/``message``)
# are present in the signature — a PASS receipt (empty list) is a strict subset.
FAIL_INVOICE = os.path.join(HERE, "corpus", "synthetic",
                            "synth-ubl-bad-vat-mismatch.xml")
PASS_INVOICE = os.path.join(HERE, "corpus", "vendored", "valid",
                            "cen-bis3-positive_ubl.xml")


def key_paths(obj, prefix=""):
    """Return the SET of dotted key paths in ``obj``.

    Dict keys extend the path; list elements are folded under a ``[]`` segment
    so the signature is independent of list length (0, 1 or many entries with
    the same element shape collapse to one set of paths). Leaf scalar VALUES are
    deliberately ignored — this captures STRUCTURE, not content, so it does not
    change when a hash or a rule id changes.
    """
    paths = set()
    if isinstance(obj, dict):
        for key in obj:
            here = "%s.%s" % (prefix, key) if prefix else key
            paths.add(here)
            paths |= key_paths(obj[key], here)
    elif isinstance(obj, list):
        for item in obj:
            paths |= key_paths(item, prefix + "[]")
    return paths


# The canonical receipt shape, frozen per structure-version. The KEY is the
# integer N from ``einvoice-conformance-receipt/N``; the VALUE is the exact set
# of key paths ``build_receipt`` must emit for that version.
#
# HOW TO EVOLVE THE RECEIPT (read before you touch receipt.py):
#   * Adding/removing/renaming a receipt field is a STRUCTURAL change. When you
#     make one intentionally you MUST (a) bump the ``/N`` suffix in
#     RECEIPT_FORMAT (einvoice/receipt.py) and (b) add the new shape under the
#     new N here. The golden receipts also change and are regenerated as a
#     reviewed decision — this guard makes the version bump non-optional.
#   * ``issued_at`` is an OPTIONAL field (only present when a caller passes it),
#     so it is NOT part of the default canonical shape and is excluded below.
SHAPE_BY_VERSION = {
    1: frozenset({
        "content_sha256",
        "receipt",
        "receipt.failed_fatal_rules",
        "receipt.failed_fatal_rules[].message",
        "receipt.failed_fatal_rules[].rule",
        "receipt.format",
        "receipt.input_sha256",
        "receipt.profile",
        "receipt.tool",
        "receipt.tool.name",
        "receipt.tool.version",
        "receipt.verdict",
        "receipt.well_formed",
    }),
}


def _version_of(receipt_format):
    """Parse the trailing integer N out of ``.../N``. Raises on a malformed marker."""
    suffix = receipt_format.rsplit("/", 1)[-1]
    if not re.fullmatch(r"[0-9]+", suffix):
        raise AssertionError(
            "RECEIPT_FORMAT %r must end in '/<integer>'" % (receipt_format,))
    return int(suffix)


class FixtureAnchors(unittest.TestCase):
    def test_fixtures_exist(self):
        self.assertTrue(os.path.isfile(FAIL_INVOICE), FAIL_INVOICE)
        self.assertTrue(os.path.isfile(PASS_INVOICE), PASS_INVOICE)

    def test_fail_fixture_populates_failed_rules(self):
        # If a corpus refresh made this invoice PASS, the shape signature would
        # silently lose its nested per-rule keys — catch that here, loudly.
        receipt = build_receipt(FAIL_INVOICE)["receipt"]
        self.assertEqual(receipt["verdict"], "FAIL")
        self.assertTrue(receipt["failed_fatal_rules"],
                        "fixture drift: FAIL invoice no longer fails")


class FormatIsEmitted(unittest.TestCase):
    """(1) The built receipt actually carries format == RECEIPT_FORMAT."""

    def test_built_receipt_format_equals_symbol(self):
        for path in (PASS_INVOICE, FAIL_INVOICE):
            body = build_receipt(path)["receipt"]
            # Compared against the imported symbol, never a copied literal.
            self.assertEqual(body["format"], RECEIPT_FORMAT, path)

    def test_receipt_json_carries_the_format_marker(self):
        # The canonical serialized text (what the CLI emits) contains it too.
        self.assertIn('"format":"%s"' % RECEIPT_FORMAT, receipt_json(PASS_INVOICE))


class StructureVersionIsBound(unittest.TestCase):
    """(2) The '/N' marker is bound to the receipt's canonical key-shape."""

    def test_marker_parses_to_a_known_version(self):
        version = _version_of(RECEIPT_FORMAT)
        self.assertIn(
            version, SHAPE_BY_VERSION,
            "RECEIPT_FORMAT is %r (version %d) but SHAPE_BY_VERSION has no entry "
            "for version %d. If you bumped the version for a structural change, "
            "register the new canonical shape under key %d here."
            % (RECEIPT_FORMAT, version, version, version))

    def test_actual_shape_matches_the_declared_version(self):
        version = _version_of(RECEIPT_FORMAT)
        expected = SHAPE_BY_VERSION[version]
        actual = key_paths(build_receipt(FAIL_INVOICE))
        self.assertEqual(
            actual, expected,
            "\nReceipt canonical STRUCTURE drifted from what "
            "RECEIPT_FORMAT=%r (version %d) promises.\n"
            "  unexpected new paths: %s\n"
            "  missing expected paths: %s\n"
            "If this shape change was INTENTIONAL, bump the version suffix in "
            "RECEIPT_FORMAT (einvoice/receipt.py -> "
            "einvoice-conformance-receipt/N) and add the new shape under that N "
            "in SHAPE_BY_VERSION. A structural change WITHOUT a version bump is "
            "what this guard exists to stop."
            % (RECEIPT_FORMAT, version,
               sorted(actual - expected), sorted(expected - actual)))

    def test_pass_receipt_shape_is_a_subset_of_the_version_shape(self):
        # A PASS receipt has an empty failed_fatal_rules list, so it omits the
        # nested per-rule keys but introduces none of its own.
        version = _version_of(RECEIPT_FORMAT)
        expected = SHAPE_BY_VERSION[version]
        actual = key_paths(build_receipt(PASS_INVOICE))
        self.assertTrue(
            actual <= expected,
            "PASS receipt carries paths outside the declared shape: %s"
            % sorted(actual - expected))


if __name__ == "__main__":
    unittest.main(verbosity=2)

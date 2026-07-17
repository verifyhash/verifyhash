#!/usr/bin/env python3
"""test_api_contract.py — signature-freeze drift guard for the public API.

Task T-VHAPI.3: ``api_contract.json`` pins the frozen shape of every name in
:data:`einvoice.__all__` (function signatures via ``inspect.signature``, the
``Result`` member surface, the ``NotWellFormed`` base + init, the ``validate``
submodule name). This test recomputes all of it LIVE from the imported package
on every run — independently of the generator's own logic — and asserts it
matches the committed artifact, so no signature/field change can ship without
a visible, reviewed diff.

If this test fails, that is a DELIBERATE-REGENERATION event per API.md's
"Stability policy": rerun ``python3 gen_api_contract.py``, review the diff
against the policy (the eight names are back-compat within a report schema
version), and document the change — NEVER loosen or skip this test.

Fast, stdlib-only, saxonche-free, offline:  python3 test_api_contract.py
"""

import inspect
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import einvoice  # noqa: E402  (the nested einvoice/einvoice/ package)

CONTRACT_PATH = os.path.join(HERE, "api_contract.json")

#: Appended to every drift assertion so the maintainer knows the ONE correct
#: response (regenerate + document), and what is forbidden (loosening).
DRIFT_HOWTO = (
    "\n\nThis is a public-API drift guard. A mismatch means the embedding "
    "contract changed. Per API.md 'Stability policy' this is a "
    "deliberate-regeneration event: rerun `python3 gen_api_contract.py`, "
    "review the resulting api_contract.json diff against the policy, and "
    "document the change in API.md. Do NOT loosen, skip, or special-case "
    "this test."
)


def _live_public_members(cls):
    """Sorted public members of ``cls`` — same definition the generator uses
    (class-body names plus class-level ``__annotations__``), spelled out here
    independently so the test cannot inherit a generator bug."""
    names = {k for k in vars(cls) if not k.startswith("_")}
    names |= {k for k in getattr(cls, "__annotations__", {})
              if not k.startswith("_")}
    return sorted(names)


def _live_shape(obj):
    """Recompute the frozen shape of one public object via ``inspect``."""
    if inspect.ismodule(obj):
        return {"kind": "module", "module": obj.__name__}
    if inspect.isclass(obj):
        if issubclass(obj, BaseException):
            return {
                "kind": "exception",
                "base": obj.__mro__[1].__name__,
                "init": str(inspect.signature(obj.__init__)),
            }
        return {
            "kind": "class",
            "init": str(inspect.signature(obj.__init__)),
            "public_members": _live_public_members(obj),
        }
    return {"kind": "function", "signature": str(inspect.signature(obj))}


class ApiContractTest(unittest.TestCase):
    """Committed api_contract.json ⇔ live package, both directions."""

    @classmethod
    def setUpClass(cls):
        with open(CONTRACT_PATH, "rb") as fh:
            cls.raw = fh.read()
        cls.doc = json.loads(cls.raw.decode("utf-8"))

    # ---------------------------------------------------------------- shape
    def test_document_structure(self):
        """The artifact has the expected top-level structure + policy note."""
        self.assertEqual(sorted(self.doc), ["_contract", "api"])
        meta = self.doc["_contract"]
        self.assertIsInstance(meta.get("version"), int)
        self.assertIn("API.md 'Stability policy'", meta.get("policy", ""),
                      "the artifact must point maintainers at API.md's "
                      "stability policy" + DRIFT_HOWTO)

    def test_key_set_equals_all_both_directions(self):
        """Every export is pinned; every pinned name is still exported.

        Direction 1 (missing pin): a NEW name added to einvoice.__all__ cannot
        ship unpinned. Direction 2 (stale pin): a name removed from __all__
        (itself a breaking change) leaves a stale artifact entry behind.
        """
        pinned = set(self.doc["api"])
        exported = set(einvoice.__all__)
        self.assertEqual(
            sorted(exported - pinned), [],
            "einvoice.__all__ exports NOT pinned in api_contract.json "
            "(a new public name must be frozen before it ships)" + DRIFT_HOWTO)
        self.assertEqual(
            sorted(pinned - exported), [],
            "api_contract.json pins names NO LONGER in einvoice.__all__ "
            "(removing a public name is a breaking change)" + DRIFT_HOWTO)
        # And __all__ still has exactly the eight documented names.
        self.assertEqual(len(exported), 8,
                         "einvoice.__all__ changed size" + DRIFT_HOWTO)

    # ------------------------------------------------------- live recompute
    def test_every_shape_matches_live_package(self):
        """Structural equality: committed shape == inspect-recomputed shape,
        name by name, with a per-name diff on failure."""
        for name in sorted(einvoice.__all__):
            with self.subTest(name=name):
                live = _live_shape(getattr(einvoice, name))
                self.assertEqual(
                    self.doc["api"].get(name), live,
                    "public API drift for %r:\n  committed: %r\n  live:      %r"
                    % (name, self.doc["api"].get(name), live) + DRIFT_HOWTO)

    def test_function_signatures_verbatim(self):
        """Belt-and-braces: every callable's committed signature string equals
        the exact live ``str(inspect.signature(...))`` (no normalisation)."""
        for name, shape in sorted(self.doc["api"].items()):
            if shape.get("kind") != "function":
                continue
            with self.subTest(name=name):
                self.assertEqual(
                    shape["signature"],
                    str(inspect.signature(getattr(einvoice, name))),
                    "signature drift for einvoice.%s" % name + DRIFT_HOWTO)

    # -------------------------------------------------------- byte identity
    def test_byte_identical_to_regeneration(self):
        """The committed file is byte-identical to what the generator emits
        NOW (sorted keys, 2-space indent, trailing newline) — catches
        formatting drift and hand-edits, not just semantic drift."""
        import gen_api_contract
        self.assertEqual(
            self.raw, gen_api_contract.render_contract().encode("utf-8"),
            "api_contract.json is not byte-identical to a fresh "
            "`python3 gen_api_contract.py` run" + DRIFT_HOWTO)
        self.assertTrue(self.raw.endswith(b"\n"),
                        "artifact must end with a trailing newline")


if __name__ == "__main__":
    unittest.main(verbosity=2)

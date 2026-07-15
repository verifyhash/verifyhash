#!/usr/bin/env python3
"""test_typing.py — the public embedding API carries resolvable type hints.

Task T-VHAPI.2. No type checker is installed (and none may be), so this proves
the type contract with the standard library ALONE: it uses
``typing.get_type_hints`` to confirm every public callable's annotations
actually *resolve* at import time (a string annotation that names an
unimportable type would raise here), that the two entry points are annotated to
return :class:`einvoice.Result` AND genuinely do so on a live call (the
annotation matches the runtime shape), and that the PEP 561 ``py.typed`` marker
both exists on disk and is declared as wheel package-data so the hints ship.

Fast, stdlib-only, saxonche-free, offline. Reuses the same known-good corpus
invoice the report/api gates use — no new invoice bodies are invented.
"""

import os
import re
import sys
import typing
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import einvoice  # noqa: E402

# The exact known-good EN 16931 UBL fixture the other fast gates open.
GOOD = os.path.join(
    HERE, "corpus", "xrechnung-testsuite", "src", "test", "business-cases",
    "standard", "01.01a-INVOICE_ubl.xml")

# The public embedding API mapped to the CALLABLE whose type hints we
# introspect. ``validate_file`` / ``validate_root`` are plain functions;
# ``Result`` and ``NotWellFormed`` are classes, so we introspect their
# constructors (that is the callable a user invokes, and the object that
# carries a resolvable, ``return``-annotated signature).
#
# The fifth ``__all__`` name, ``validate``, is DELIBERATELY not here: it is the
# re-exported orchestration *submodule* (see einvoice/__init__.py), not a
# callable, so ``get_type_hints`` on it is meaningless — it is skipped on
# purpose and asserted to be a module below.
API_CALLABLES = {
    "validate_file": einvoice.validate_file,
    "validate_root": einvoice.validate_root,
    "Result": einvoice.Result.__init__,
    "NotWellFormed": einvoice.NotWellFormed.__init__,
}


class HintsResolve(unittest.TestCase):
    """Every public callable's annotations resolve to real types."""

    def test_get_type_hints_resolves_with_return_key(self):
        for name, fn in API_CALLABLES.items():
            with self.subTest(name=name):
                # Would raise NameError if any annotation named an
                # unimportable / mistyped type — that is the whole point.
                hints = typing.get_type_hints(fn)
                self.assertTrue(hints, "%s: hints must be non-empty" % name)
                self.assertIn("return", hints,
                              "%s: needs a return annotation" % name)

    def test_validate_submodule_entry_is_skipped_not_callable(self):
        # Documents why 'validate' is absent from API_CALLABLES: it is the
        # submodule, not a callable — get_type_hints would be meaningless.
        import types
        self.assertIn("validate", einvoice.__all__)
        self.assertIsInstance(einvoice.validate, types.ModuleType)
        self.assertNotIn("validate", API_CALLABLES)


class ReturnAnnotationMatchesRuntime(unittest.TestCase):
    """The two entry points are annotated -> Result AND live-return a Result."""

    def test_entry_points_annotated_result(self):
        for fn in (einvoice.validate_file, einvoice.validate_root):
            with self.subTest(fn=fn.__name__):
                self.assertIs(typing.get_type_hints(fn)["return"],
                              einvoice.Result)

    def test_result_members_annotated(self):
        # The documented Result surface carries precise annotations.
        init_hints = typing.get_type_hints(einvoice.Result.__init__)
        self.assertIs(init_hints["return"], type(None))
        self.assertIs(typing.get_type_hints(einvoice.Result.to_dict)["return"],
                      dict)
        # .ok / .valid / .first are properties -> introspect their getters.
        self.assertIs(
            typing.get_type_hints(einvoice.Result.ok.fget)["return"], bool)
        self.assertIs(
            typing.get_type_hints(einvoice.Result.valid.fget)["return"], bool)

    def test_live_call_returns_result(self):
        # Annotation says -> Result; a real run must actually produce one.
        with open(GOOD, "rb") as fh:
            payload = fh.read()
        import io
        r_file = einvoice.validate_file(io.BytesIO(payload), profile="en16931")
        self.assertIsInstance(r_file, einvoice.Result)
        # And validate_root over the parsed root of the same invoice.
        from einvoice import parser as _parser
        root = _parser.parse_file(GOOD)
        r_root = einvoice.validate_root(root, profile="en16931")
        self.assertIsInstance(r_root, einvoice.Result)


class PyTypedMarkerShips(unittest.TestCase):
    """PEP 561: marker exists on disk AND is declared as wheel package-data."""

    def test_marker_file_exists(self):
        marker = os.path.join(HERE, "einvoice", "py.typed")
        self.assertTrue(os.path.isfile(marker),
                        "einvoice/py.typed marker must exist (PEP 561)")

    def test_pyproject_declares_marker_as_package_data(self):
        with open(os.path.join(HERE, "pyproject.toml"), encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("[tool.setuptools.package-data]", text,
                      "pyproject.toml must declare a package-data table")
        m = re.search(r'^\s*einvoice\s*=\s*\[([^\]]*)\]', text, re.M)
        self.assertIsNotNone(
            m, "package-data must list files for the einvoice package")
        self.assertIn("py.typed", m.group(1),
                      "py.typed must be declared as einvoice package-data so "
                      "it ships in the wheel")


if __name__ == "__main__":
    unittest.main(verbosity=2)

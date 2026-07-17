#!/usr/bin/env python3
"""test_api_recipe.py — execute the documented test-suite recipe verbatim.

Task T-VHEMBED.2: API.md carries a section titled "Embed einvoice in your
test suite" with ONE fenced Python block — a pytest-style recipe (plain
assert functions, no pytest import) built only from documented public names
(``einvoice.validate_file``, ``einvoice.fails_at``). This test EXTRACTS that
exact fenced block from API.md and exec()s it, so the recipe on the page can
never silently drift from what the library actually does:

  * bound to the known-good corpus invoice, both recipe tests PASS;
  * bound to the fatally-invalid committed fixture, the severity-gate
    assertion RAISES ``AssertionError`` (and so does the validity test) —
    both directions asserted.

The recipe references its fixture through the ``INVOICE_PATH`` module
variable, which the functions read at call time; this test rebinds it to the
real committed fixtures after exec(). Fast, stdlib-only, saxonche-free,
offline. No new invoice bodies: reuses the exact fixtures test_api_example.py
and test_api_embed.py already drive.
"""

import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

API_MD = os.path.join(HERE, "API.md")
SECTION_TITLE = "## Embed einvoice in your test suite"

# The known-good EN 16931 UBL corpus invoice (same file test_api_example.py
# and the report/xrechnung gates use).
GOOD = os.path.join(
    HERE, "corpus", "xrechnung-testsuite", "src", "test", "business-cases",
    "standard", "01.01a-INVOICE_ubl.xml")

# The fatally-invalid committed fixture (1 fatal BR-CL-01 under en16931 —
# same file test_api_embed.py and test_exit_codes.py drive).
BAD = os.path.join(HERE, "fixtures", "creditnote-invalid-typecode_ubl.xml")


def extract_recipe_snippet():
    """Return the single fenced Python block under SECTION_TITLE, verbatim."""
    with open(API_MD, encoding="utf-8") as fh:
        text = fh.read()
    start = text.find("\n" + SECTION_TITLE + "\n")
    if start < 0:
        raise AssertionError("API.md section not found: %r" % SECTION_TITLE)
    start += 1  # past the leading newline
    # Section runs to the next H2 heading (or EOF).
    nxt = text.find("\n## ", start + len(SECTION_TITLE))
    section = text[start:nxt if nxt >= 0 else len(text)]
    blocks = re.findall(r"```python\n(.*?)```", section, flags=re.DOTALL)
    if len(blocks) != 1:
        raise AssertionError(
            "expected exactly ONE fenced python block in the recipe section, "
            "found %d" % len(blocks))
    return blocks[0]


class RecipeSnippetShape(unittest.TestCase):
    """Structural contract: one block, public names only, dependency-free."""

    def setUp(self):
        self.code = extract_recipe_snippet()

    def test_public_api_only_no_private_imports(self):
        # The only import is the top-level public package.
        imports = re.findall(r"^\s*(?:import|from)\s+\S+.*$",
                             self.code, flags=re.MULTILINE)
        self.assertEqual(imports, ["import einvoice"], imports)
        # No reaching into internal submodules anywhere in the snippet.
        self.assertNotRegex(self.code, r"einvoice\.(parser|rules|report|"
                                       r"codelists|pdf_container|"
                                       r"syntax_binding|cli)\b")
        # Only documented public callables are used.
        called = set(re.findall(r"einvoice\.(\w+)\s*\(", self.code))
        self.assertTrue(called.issubset({"validate", "validate_file",
                                         "validate_root", "validate_batch",
                                         "fails_at", "capabilities"}), called)
        self.assertIn("validate_file", called)
        self.assertIn("fails_at", called)

    def test_pytest_style_but_pytest_free(self):
        self.assertNotIn("import pytest", self.code)  # stdlib-runnable, no dep
        # Fixture path is bound through a variable, not inlined in the calls.
        self.assertRegex(self.code, r"(?m)^INVOICE_PATH\s*=", "recipe must "
                         "bind its fixture via the INVOICE_PATH variable")
        self.assertRegex(self.code, r"(?m)^FAIL_LEVEL\s*=")
        # Two plain test functions with bare asserts.
        self.assertIn("def test_invoice_is_valid():", self.code)
        self.assertIn("def test_invoice_clears_severity_gate():", self.code)


class RecipeExecutesVerbatim(unittest.TestCase):
    """exec() the exact fenced block; prove BOTH directions."""

    def _load(self, invoice_path):
        code = extract_recipe_snippet()
        ns = {"__name__": "user_conformance_test"}  # not __main__: the guard
        exec(compile(code, "API.md#embed-einvoice-in-your-test-suite",
                     "exec"), ns)                   # must not run on import
        # Bind the documented variable to a real committed fixture, exactly
        # as a user pointing INVOICE_PATH at their own invoice would.
        ns["INVOICE_PATH"] = invoice_path
        return ns

    def test_fixtures_exist(self):
        # Fixture-drift guard: both committed inputs are on disk.
        self.assertTrue(os.path.isfile(GOOD), GOOD)
        self.assertTrue(os.path.isfile(BAD), BAD)

    def test_recipe_passes_on_known_good_invoice(self):
        ns = self._load(GOOD)
        ns["test_invoice_is_valid"]()             # no AssertionError
        ns["test_invoice_clears_severity_gate"]()  # no AssertionError

    def test_severity_gate_raises_on_fatally_invalid_fixture(self):
        ns = self._load(BAD)
        self.assertEqual(ns["FAIL_LEVEL"], "fatal")  # documented default
        with self.assertRaises(AssertionError) as ctx:
            ns["test_invoice_clears_severity_gate"]()
        # The documented failure payload names the fired rule.
        self.assertIn("BR-CL-01", str(ctx.exception))
        # The validity assertion trips too (fatal == not result.valid).
        with self.assertRaises(AssertionError):
            ns["test_invoice_is_valid"]()

    def test_exec_defines_only_declarations_no_side_effects(self):
        # exec()ing the snippet must not validate anything by itself: the
        # placeholder INVOICE_PATH points at a file that does not exist here,
        # and _load() would blow up on import if the module body touched it.
        ns = self._load(GOOD)
        self.assertFalse(os.path.exists(os.path.join(HERE,
                         "billing", "fixtures")), "placeholder path must "
                         "stay a placeholder — never a committed file")
        self.assertTrue(callable(ns["test_invoice_is_valid"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)

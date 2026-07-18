#!/usr/bin/env python3
"""test_config_discovery.py — pin the einvoice config *discovery* contract.

The config loader (einvoice/config.py :func:`load_config` /
:func:`load_config_with_source`) resolves its opt-in defaults from the
**current working directory only**. It checks ``<cwd>/.einvoice.toml`` first,
then the ``[tool.einvoice]`` table in ``<cwd>/pyproject.toml`` — and it does
**not** walk parent directories the way git looks up from the cwd for a
``.git``. test_config_file.py exercises each *key* through the live CLI from a
fresh empty temp cwd, but it never pins the LOOKUP contract itself: nothing
there asserts that a config sitting in a PARENT directory is ignored, nor that
the precedence when both files coexist uses the public filename constants.

This suite pins WHAT THE CODE ACTUALLY DOES (it does not ask for a new
parent-walk feature — that is deliberately absent):

  * a ``.einvoice.toml`` in a PARENT dir is NOT discovered from an empty child
    cwd — ``load_config`` returns ``{}`` and the source is ``None``;
  * same for a parent ``pyproject.toml`` ``[tool.einvoice]`` table;
  * when BOTH files exist in the cwd, ``.einvoice.toml`` WINS — its values are
    returned and the source is :data:`config.CONFIG_FILENAME` (asserted via the
    module constant, never a hardcoded filename literal);
  * a doc-drift guard: the config documentation states the cwd-only /
    no-parent-walk / ``.einvoice.toml``-wins contract in prose.

Self-contained, stdlib-only, offline. cwd is saved/restored in a
``try/finally`` exactly like test_config_file.py's setUp/tearDown, so the
repo's own pyproject.toml is never in the lookup path and no temp file leaks.

Run: python3 test_config_discovery.py
"""

import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice import config as einvoice_config  # noqa: E402

# The config documentation lives in the QUICKSTART "config file" section
# (grep: QUICKSTART.md § "Project-wide defaults: the [tool.einvoice] config
# file"). The doc-drift assertion reads THIS file.
CONFIG_DOC = os.path.join(HERE, "QUICKSTART.md")


class _TmpCwd(unittest.TestCase):
    """Mirror test_config_file.py: each test runs with cwd = a fresh empty
    temp dir, restored in tearDown, so the repo's own pyproject.toml is never
    in the config lookup path and nothing written here can leak into the repo.
    ``self._tmp.name`` is the temp ROOT used to build parent/child layouts."""

    def setUp(self):
        self._old_cwd = os.getcwd()
        self._tmp = tempfile.TemporaryDirectory(prefix="einvoice-disc-")
        os.chdir(self._tmp.name)

    def tearDown(self):
        os.chdir(self._old_cwd)
        self._tmp.cleanup()

    def _write(self, directory, name, text):
        with open(os.path.join(directory, name), "w", encoding="utf-8") as fh:
            fh.write(text)

    def _empty_child(self):
        """Create and return an empty ``child/`` subdir under the temp root."""
        child = os.path.join(self._tmp.name, "child")
        os.mkdir(child)
        return child


class ParentConfigNotDiscovered(_TmpCwd):
    """A config in a PARENT directory is invisible from a child cwd — the
    loader does NOT walk upward. This is the contract nobody asked to change."""

    def test_parent_einvoice_toml_not_discovered_from_child(self):
        # .einvoice.toml in the parent (temp root), cwd = an EMPTY child subdir.
        self._write(self._tmp.name, einvoice_config.CONFIG_FILENAME,
                    'lang = "de"\n')
        child = self._empty_child()
        os.chdir(child)
        cfg, source = einvoice_config.load_config_with_source()
        self.assertEqual(cfg, {})       # nothing picked up from the parent
        self.assertIsNone(source)       # no source file contributed
        # The thin wrapper agrees.
        self.assertEqual(einvoice_config.load_config(), {})

    def test_parent_config_seen_only_when_it_IS_the_cwd(self):
        # Control: the SAME file resolved with cwd = the dir that holds it IS
        # found — proving the negatives above are about the LOOKUP dir, not a
        # broken/ignored file. (load_config accepts an explicit cwd.)
        self._write(self._tmp.name, einvoice_config.CONFIG_FILENAME,
                    'lang = "de"\n')
        cfg, source = einvoice_config.load_config_with_source(self._tmp.name)
        self.assertEqual(cfg, {"lang": "de"})
        self.assertEqual(source, einvoice_config.CONFIG_FILENAME)


class ParentPyprojectNotDiscovered(_TmpCwd):
    """A parent ``pyproject.toml`` ``[tool.einvoice]`` table is equally
    invisible from a child cwd — no upward walk for pyproject either."""

    def test_parent_pyproject_tool_einvoice_not_discovered_from_child(self):
        self._write(self._tmp.name, einvoice_config.PYPROJECT_FILENAME,
                    '[project]\nname = "x"\nversion = "0.0.1"\n'
                    '[tool.einvoice]\nlang = "de"\n')
        child = self._empty_child()
        os.chdir(child)
        cfg, source = einvoice_config.load_config_with_source()
        self.assertEqual(cfg, {})
        self.assertIsNone(source)

    def test_parent_pyproject_seen_only_when_it_IS_the_cwd(self):
        # Same control as above for the pyproject leg.
        self._write(self._tmp.name, einvoice_config.PYPROJECT_FILENAME,
                    '[tool.einvoice]\nlang = "de"\n')
        cfg, source = einvoice_config.load_config_with_source(self._tmp.name)
        self.assertEqual(cfg, {"lang": "de"})
        self.assertEqual(source, einvoice_config.PYPROJECT_FILENAME)


class EinvoiceTomlWinsInSameDir(_TmpCwd):
    """When BOTH files exist in the cwd, ``.einvoice.toml`` wins outright —
    its values are returned and the reported source is CONFIG_FILENAME. The
    assertion uses the module constants, never a hardcoded filename string."""

    def test_einvoice_toml_beats_pyproject_in_same_cwd(self):
        # Distinct values so the WINNER is unambiguous: pyproject says 'de',
        # .einvoice.toml says 'en'. If .einvoice.toml wins we see 'en'.
        self._write(self._tmp.name, einvoice_config.PYPROJECT_FILENAME,
                    '[tool.einvoice]\nlang = "de"\nformat = "json"\n')
        self._write(self._tmp.name, einvoice_config.CONFIG_FILENAME,
                    'lang = "en"\n')
        cfg, source = einvoice_config.load_config_with_source()
        self.assertEqual(source, einvoice_config.CONFIG_FILENAME)
        self.assertEqual(cfg, {"lang": "en"})       # .einvoice.toml's value
        # And decidedly NOT the pyproject table (its 'de'/'format' never read).
        self.assertNotIn("format", cfg)
        self.assertNotEqual(source, einvoice_config.PYPROJECT_FILENAME)


class ConfigDocStatesDiscoveryContract(unittest.TestCase):
    """Doc-drift guard: the config documentation must SPELL OUT the discovery
    contract in prose — cwd-only, no parent-directory walk, and
    ``.einvoice.toml`` precedence — so the docs cannot silently drift from the
    pinned code above. Reuses the public filename constants for the file names
    it looks for."""

    def test_doc_states_cwd_only_no_parent_walk_and_precedence(self):
        self.assertTrue(os.path.isfile(CONFIG_DOC), CONFIG_DOC)
        with open(CONFIG_DOC, encoding="utf-8") as fh:
            text = fh.read()
        low = text.lower()

        # (1) cwd-only: names the current working directory as the lookup site.
        self.assertIn("current working director", low,
                      "config doc must state the lookup is the current "
                      "working directory")
        # (2) no parent-directory search, stated explicitly.
        self.assertTrue(
            "no parent-directory search" in low
            or ("parent" in low and "not" in low),
            "config doc must state there is NO parent-directory search")
        self.assertIn("parent", low)
        # (3) both config filenames are documented (via the module constants).
        self.assertIn(einvoice_config.CONFIG_FILENAME, text)
        self.assertIn(einvoice_config.PYPROJECT_FILENAME, text)
        # (4) .einvoice.toml precedence is stated in prose.
        self.assertIn("precedence", low)


if __name__ == "__main__":
    unittest.main(verbosity=2)

#!/usr/bin/env python3
"""Release-discipline guard: one version, three files, byte-equal.

The einvoice subproduct declares its version in three independent places:

  1. ``einvoice/pyproject.toml``            -> the packaging metadata
  2. ``einvoice/einvoice/__init__.py``      -> ``einvoice.__version__``
  3. ``einvoice/CHANGELOG.md``              -> the topmost released heading

If a release bumps one and forgets another, the tool ships a lie: a wheel
whose ``__version__`` disagrees with its own changelog. This test makes the
CHANGELOG a real participant in the single source of truth by asserting all
three are *byte-equal*, and it fails loudly if any pair diverges.

Zero third-party dependencies on purpose: Python 3.10's stdlib has no
``tomllib`` (that arrived in 3.11) and we refuse to add ``tomli``/``toml`` —
so the ``pyproject.toml`` version is extracted with a small, explicit regex.
"""

from __future__ import annotations

import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PYPROJECT = os.path.join(HERE, "pyproject.toml")
INIT_PY = os.path.join(HERE, "einvoice", "__init__.py")
CHANGELOG = os.path.join(HERE, "CHANGELOG.md")


def _read(path: str) -> str:
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def pyproject_version() -> str:
    """Version from the ``[project]`` table of pyproject.toml, via regex.

    Deliberately does NOT import a TOML parser: 3.10 has no ``tomllib`` and
    the zero-dependency contract forbids ``tomli``/``toml``. We scope the
    search to the ``[project]`` table so a ``version`` key under any other
    table can never be mistaken for the project version.
    """
    text = _read(PYPROJECT)
    # Isolate the [project] table: everything after the "[project]" header up
    # to the next top-level "[table]" header (but not "[project.xxx]" subtables,
    # which do not carry the package version anyway).
    m = re.search(r"(?m)^\[project\]\s*$", text)
    if not m:
        raise AssertionError("pyproject.toml has no [project] table")
    rest = text[m.end():]
    nxt = re.search(r"(?m)^\[[^\]]+\]\s*$", rest)
    section = rest[: nxt.start()] if nxt else rest
    vm = re.search(r"""(?m)^\s*version\s*=\s*["']([^"']+)["']\s*$""", section)
    if not vm:
        raise AssertionError("no 'version = \"...\"' line under [project]")
    return vm.group(1)


def init_version() -> str:
    """``einvoice.__version__`` — the value the installed package exposes."""
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    import einvoice  # noqa: E402  (path set up above)

    version = getattr(einvoice, "__version__", None)
    if not isinstance(version, str) or not version:
        raise AssertionError("einvoice.__version__ missing or not a string")
    return version


def changelog_version() -> str:
    """The topmost version in CHANGELOG.md.

    Matches the first Keep-a-Changelog release heading, i.e. a line like
    ``## [0.1.0] - 2026-07-07`` or ``## 0.1.0``. An "Unreleased" heading is
    skipped so it never shadows the real latest version.
    """
    for line in _read(CHANGELOG).splitlines():
        if not line.startswith("##"):
            continue
        if re.search(r"unreleased", line, re.IGNORECASE):
            continue
        m = re.search(r"##\s*\[?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)\]?", line)
        if m:
            return m.group(1)
    raise AssertionError("no version heading (e.g. '## [0.1.0]') in CHANGELOG.md")


class TestReleaseDiscipline(unittest.TestCase):
    def test_all_three_sources_exist(self) -> None:
        for path in (PYPROJECT, INIT_PY, CHANGELOG):
            self.assertTrue(os.path.isfile(path), f"missing release file: {path}")

    def test_changelog_has_keep_a_changelog_marker(self) -> None:
        text = _read(CHANGELOG).lower()
        self.assertIn("keep a changelog", text)

    def test_pyproject_matches_init(self) -> None:
        self.assertEqual(
            pyproject_version(),
            init_version(),
            "pyproject.toml [project].version != einvoice.__version__ "
            "— bump both together.",
        )

    def test_init_matches_changelog(self) -> None:
        self.assertEqual(
            init_version(),
            changelog_version(),
            "einvoice.__version__ != topmost CHANGELOG.md version "
            "— add/rename the changelog section for the new version.",
        )

    def test_pyproject_matches_changelog(self) -> None:
        self.assertEqual(
            pyproject_version(),
            changelog_version(),
            "pyproject.toml [project].version != topmost CHANGELOG.md version.",
        )

    def test_all_three_byte_equal(self) -> None:
        versions = {
            "pyproject.toml": pyproject_version(),
            "einvoice.__version__": init_version(),
            "CHANGELOG.md": changelog_version(),
        }
        self.assertEqual(
            len(set(versions.values())),
            1,
            f"version drift across the single source of truth: {versions}",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)

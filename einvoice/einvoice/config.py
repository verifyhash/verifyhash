"""Opt-in config-file defaults for the einvoice CLI.

At startup, :func:`einvoice.cli._main` calls :func:`load_config` ONCE (at
arg-parse level, so ``validate`` and ``validate-batch`` — and every other
subcommand — resolve identically, never per-subcommand copies). The lookup
order in the current working directory:

  1. ``.einvoice.toml`` — the whole file is the config table (keys at the
     TOP level, no ``[tool.einvoice]`` header). When this file exists it
     WINS outright: the ``pyproject.toml`` table is not even read.
  2. else the ``[tool.einvoice]`` table inside ``./pyproject.toml``.
  3. else: no config — ``{}`` — and the CLI behaves byte-identically to a
     build without this module (every built-in default unchanged).

Recognized keys (EXACTLY these — hyphenated bare keys are legal TOML):

  * ``format``   — default output form of the main CLI: ``"text"`` (the
                   human summary, today's default) or ``"json"`` (as if
                   ``--json`` were passed).
  * ``fail-on``  — default ``--fail-on`` severity threshold
                   (``fatal`` | ``warning`` | ``information``).
  * ``lang``     — default ``--lang`` of the human summary (``en`` | ``de``).

Precedence: explicit CLI flag > config file > built-in default. The values
are handed to the CLI as *defaults only*; a flag given on the command line
always wins.

Error taxonomy (never silently swallowed): an UNKNOWN key anywhere in the
examined table raises :class:`ConfigError` naming the bad key and the
accepted set; so does a non-string value and an unreadable/unparseable
file. The CLI maps :class:`ConfigError` onto the EXISTING usage-error exit
(2, see EXIT-CODES.md). An invalid VALUE for a recognized key (e.g.
``lang = "fr"``) is deliberately NOT judged here: the CLI runs it through
the very same vocabulary checks a bad ``--lang``/``--fail-on`` flag hits,
so the error path (message shape + exit 2) is identical to the flag
equivalent.

TOML parsing: ``tomllib`` when the interpreter ships it (Python >= 3.11),
else the stdlib-only minimal fallback below — adapted from the parser
pattern vendored in ``gen_sbom.py`` — so the package keeps its ZERO
runtime dependencies (test_packaging.py enforces that contract).

Standard library only.
"""

import os
import re

try:  # Python 3.11+
    import tomllib  # type: ignore
    _HAVE_TOMLLIB = True
except ModuleNotFoundError:  # Python 3.8 - 3.10: minimal fallback below
    tomllib = None  # type: ignore
    _HAVE_TOMLLIB = False

#: The dedicated config file looked up FIRST in the current directory.
CONFIG_FILENAME = ".einvoice.toml"
#: The fallback location: the ``[tool.einvoice]`` table in this file.
PYPROJECT_FILENAME = "pyproject.toml"
#: The EXACT accepted key set — anything else is an actionable error.
RECOGNIZED_KEYS = ("fail-on", "format", "lang")


class ConfigError(Exception):
    """An actionable config-file problem: unknown key, non-string value,
    or an unreadable/unparseable file. Carries a human message that names
    the offending file and (for keys) the accepted set; the CLI writes it
    as ``error: ...`` on stderr and returns the documented usage exit 2."""


class _Unparsed(object):
    """Sentinel for a value the minimal fallback parser saw but did not
    understand (an array, inline table, multi-line string, ...). It is not
    a ``str``, so a recognized key carrying one fails the must-be-a-string
    check with an honest message instead of being silently coerced."""

    def __repr__(self):  # shown inside the ConfigError message
        return "<unparsed TOML value>"


_UNPARSED = _Unparsed()

# --- Minimal stdlib-only TOML fallback (Python 3.8 - 3.10) ------------------
#
# Adapted from the parser pattern vendored in gen_sbom.py: deliberately tiny,
# line-based, and honest about its limits. It understands exactly the shapes
# an einvoice config needs — ``[dotted.table]`` headers and single-line
# ``key = <scalar>`` pairs with double/single-quoted strings, integers and
# booleans. Anything else on a value position becomes the _UNPARSED sentinel
# (surfaced as an error if it sits on a recognized key; an unknown key errors
# regardless of its value). It is NOT a general TOML parser and does not
# pretend to be one — it exists so the package keeps zero runtime deps on
# interpreters without ``tomllib``.

_TABLE_RE = re.compile(r"^\[\s*([A-Za-z0-9_.\-]+)\s*\]$")
_KEY_RE = re.compile(r"^([A-Za-z0-9_\-]+)\s*=\s*(.+)$")


def _parse_scalar(raw):
    """Parse a single-line TOML scalar: quoted string / int / bool.
    Unrecognized shapes return the _UNPARSED sentinel (never a guess)."""
    raw = raw.strip()
    m = re.match(r'^"([^"]*)"\s*(?:#.*)?$', raw)
    if m:
        return m.group(1)
    m = re.match(r"^'([^']*)'\s*(?:#.*)?$", raw)
    if m:
        return m.group(1)
    bare = re.sub(r"#.*$", "", raw).strip()
    if re.match(r"^[+-]?[0-9][0-9_]*$", bare):
        return int(bare.replace("_", ""))
    if bare in ("true", "false"):
        return bare == "true"
    return _UNPARSED


def _parse_toml_fallback(text):
    """Line-based fallback: returns nested dicts keyed by table path, e.g.
    ``[tool.einvoice]`` becomes ``{"tool": {"einvoice": {...}}}`` — the same
    shape ``tomllib.loads`` yields for the subset we consume. Lines that are
    neither a table header nor a ``key = value`` pair (blank lines, comments,
    array continuation lines from unrelated tables) are skipped."""
    root = {}
    table = root
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("[["):  # array-of-tables: out of scope
            table = {}                 # swallow its keys off to the side
            continue
        m = _TABLE_RE.match(stripped)
        if m:
            table = root
            for part in m.group(1).split("."):
                table = table.setdefault(part, {})
                if not isinstance(table, dict):  # header clashing a scalar
                    table = {}
            continue
        m = _KEY_RE.match(stripped)
        if m:
            table[m.group(1)] = _parse_scalar(m.group(2))
    return root


def _parse_toml(text):
    """``tomllib`` when available (>= 3.11), else the minimal fallback."""
    if _HAVE_TOMLLIB:
        return tomllib.loads(text)
    return _parse_toml_fallback(text)


def _read_toml(path):
    """Read + parse ``path``; every failure becomes an actionable
    :class:`ConfigError` naming the file — never a traceback."""
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except OSError as exc:
        raise ConfigError("cannot read config file %s: %s"
                          % (path, exc.strerror or exc))
    try:
        return _parse_toml(text)
    except (ValueError, UnicodeDecodeError) as exc:
        # tomllib.TOMLDecodeError subclasses ValueError.
        raise ConfigError("invalid TOML in %s: %s" % (path, exc))


def _validate_table(table, source):
    """Enforce the key/type contract on a candidate config table.

    * every key must be in :data:`RECOGNIZED_KEYS` — an unknown key raises
      naming the key, the file it came from, and the accepted set;
    * every value must be a string (the CLI's flag vocabulary is strings) —
      value CORRECTNESS (is ``lang`` one of en/de?) is left to the CLI's
      existing flag checks so config and flag errors share one path.
    """
    out = {}
    for key in sorted(table):
        if key not in RECOGNIZED_KEYS:
            raise ConfigError(
                "unknown key %r in %s (accepted keys: %s)"
                % (key, source, ", ".join(RECOGNIZED_KEYS)))
        value = table[key]
        if not isinstance(value, str):
            raise ConfigError(
                "%s in %s must be a quoted string (got %r)"
                % (key, source, value))
        out[key] = value
    return out


def load_config(cwd=None):
    """Resolve the CLI's config-file defaults from ``cwd`` (default:
    ``os.getcwd()``).

    Returns a dict holding a SUBSET of :data:`RECOGNIZED_KEYS` mapped to
    their string values — ``{}`` when no config exists, so absence costs
    nothing and changes nothing. Lookup order (documented rule:
    ``.einvoice.toml`` wins when both files exist):

      1. ``<cwd>/.einvoice.toml`` — whole file, top-level keys;
      2. ``<cwd>/pyproject.toml`` — only its ``[tool.einvoice]`` table
         (absent table == no config; every other pyproject table is none
         of our business and is ignored untouched).

    Raises :class:`ConfigError` for unknown keys, non-string values, and
    unreadable/unparseable files — never silently swallowed.
    """
    if cwd is None:
        cwd = os.getcwd()

    path = os.path.join(cwd, CONFIG_FILENAME)
    if os.path.isfile(path):
        doc = _read_toml(path)
        return _validate_table(doc, CONFIG_FILENAME)

    path = os.path.join(cwd, PYPROJECT_FILENAME)
    if os.path.isfile(path):
        doc = _read_toml(path)
        tool = doc.get("tool")
        if not isinstance(tool, dict):
            return {}
        table = tool.get("einvoice")
        if table is None:
            return {}
        if not isinstance(table, dict):
            raise ConfigError(
                "[tool.einvoice] in %s must be a table of keys "
                "(accepted keys: %s)"
                % (PYPROJECT_FILENAME, ", ".join(RECOGNIZED_KEYS)))
        return _validate_table(
            table, "%s [tool.einvoice]" % PYPROJECT_FILENAME)

    return {}

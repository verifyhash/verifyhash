"""einvoice — first-slice XRechnung / EN 16931 UBL Invoice validator.

Standard library only. See SPEC.md for scope and API.md for the stable
embedding contract.

Supported public API (the names in :data:`__all__`, back-compat within a
report ``schemaVersion``):

    * :mod:`einvoice.validate` — the validation orchestration module.
    * :func:`einvoice.validate_file` — validate a path or binary bytes buffer.
    * :func:`einvoice.validate_root` — validate an already-parsed UBL root.
    * :class:`einvoice.Result` — the validation outcome (``.valid`` +
      ``.violations``).
    * :class:`einvoice.NotWellFormed` — raised on malformed XML input.
    * :func:`einvoice.validate_batch` — validate a list of invoice files and
      get the aggregate batch report dict (the ``validate-batch`` engine).
    * :func:`einvoice.fails_at` — the CLI ``--fail-on`` severity-threshold
      predicate over a :class:`Result`.
    * :func:`einvoice.capabilities` — what THIS build contains, as a dict
      (the ``einvoice info --json`` payload).

Everything else (``parser``, ``rules``, ``rules_xrechnung``, ``codelists``,
``report`` and friends) stays importable but is internal and may change
without notice.
"""

from __future__ import annotations

import os as _os
import typing as _typing

from . import validate  # noqa: F401  (submodule kept importable; see API.md)
from .validate import validate_file, validate_root, Result  # noqa: F401
from .parser import NotWellFormed  # noqa: F401

#: Kept in lock-step with ``pyproject.toml`` (test_packaging.py enforces it).
__version__ = "0.1.0"

#: The supported, back-compat public API. Exactly these eight names are the
#: embedding contract documented in API.md; ``test_api_example.py`` guards it.
__all__ = ["validate", "validate_file", "validate_root", "Result",
           "NotWellFormed", "validate_batch", "fails_at", "capabilities"]


def validate_batch(
    paths: _typing.Iterable[str | _os.PathLike[str]],
    profile: str = "xrechnung",
) -> dict:
    """Validate every file in ``paths`` and return the aggregate batch report.

    Thin, stable wrapper around the SAME batch engine the
    ``einvoice validate-batch`` CLI drives
    (:func:`einvoice.report.build_batch_report_from_files`) — it adds no rule
    logic and changes no verdict. Each entry in the returned dict's ``files``
    array is the plain single-file report, byte-identical to validating that
    file on its own; files are validated in the order given (pass a sorted
    list for deterministic output). See API.md for the stable fields of the
    returned dict. An empty ``paths`` yields ``file_count == 0`` plus an
    explicit ``note`` — never an exception, never a fabricated pass.

    :param paths: iterable of invoice file paths (``str`` or path-like).
    :param profile: ``"xrechnung"`` (default) or ``"en16931"``.
    :returns: the aggregate batch dict (schema ``einvoice-conformance-batch/v1``).
    """
    # Lazy import: keeps ``import einvoice`` as light as before (measured —
    # cli/report only load when a batch is actually requested).
    from .report import build_batch_report_from_files
    return build_batch_report_from_files(
        [_os.fspath(p) for p in paths], profile=profile)


def fails_at(result: Result, level: str) -> bool:
    """True iff ``result`` trips the given severity threshold.

    The EXACT ``--fail-on`` semantics of the CLI, as a pure predicate: a
    :class:`Result` fails at ``level`` iff at least one of its violations has
    severity >= that level (``information`` < ``warning`` < ``fatal``). So
    ``fails_at(r, "fatal")`` is ``not r.valid`` (today's default exit rule),
    ``"warning"`` also trips on warnings, ``"information"`` on any finding at
    all. Delegates to the same threshold code the CLI exit path runs — the two
    can never disagree.

    :param result: a :class:`Result` from ``validate_file`` / ``validate_root``.
    :param level: ``"fatal"``, ``"warning"`` or ``"information"``.
    :returns: ``True`` when at least one finding crosses the threshold.
    :raises ValueError: on an unknown ``level`` (same accepted values as the
        CLI ``--fail-on`` flag; the message names the valid choices).
    """
    from .cli import FAIL_ON_LEVELS, EXIT_FAIL, _result_exit_code
    if level not in FAIL_ON_LEVELS:
        raise ValueError(
            "unknown fail-on level %r (choose from %s)"
            % (level, ", ".join(FAIL_ON_LEVELS)))
    return _result_exit_code(result, level) == EXIT_FAIL


def capabilities() -> dict:
    """What THIS build contains, as a plain dict.

    Returns exactly the payload ``einvoice info --json`` prints (same source:
    :func:`einvoice.cli._info_payload`): ``version``, ``profiles``,
    ``formats``, ``rule_count``, ``coverage`` and ``attestation_sha256``.
    Every value is read at runtime from the package or its committed
    artifacts, never retyped. Honest limit: the artifact-sourced fields
    (``rule_count``, parts of ``coverage``, ``attestation_sha256``) degrade to
    ``None`` in an installed-package context where the repo artifacts are not
    on disk — only a source checkout carries them.

    :returns: dict with the six documented keys (JSON-serialisable).
    """
    from .cli import _info_payload
    return _info_payload()

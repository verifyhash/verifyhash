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

Everything else (``parser``, ``rules``, ``rules_xrechnung``, ``codelists``,
``report`` and friends) stays importable but is internal and may change
without notice.
"""

from . import validate  # noqa: F401  (submodule kept importable; see API.md)
from .validate import validate_file, validate_root, Result  # noqa: F401
from .parser import NotWellFormed  # noqa: F401

#: Kept in lock-step with ``pyproject.toml`` (test_packaging.py enforces it).
__version__ = "0.1.0"

#: The supported, back-compat public API. Exactly these five names are the
#: embedding contract documented in API.md; ``test_api_example.py`` guards it.
__all__ = ["validate", "validate_file", "validate_root", "Result",
           "NotWellFormed"]

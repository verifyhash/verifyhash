"""einvoice — first-slice XRechnung / EN 16931 UBL Invoice validator.

Standard library only. See SPEC.md for scope.
"""

from .validate import validate_file, validate_root, Result  # noqa: F401
from .parser import NotWellFormed  # noqa: F401

#: Kept in lock-step with ``pyproject.toml`` (test_packaging.py enforces it).
__version__ = "0.1.0"

__all__ = ["validate_file", "validate_root", "Result", "NotWellFormed",
           "__version__"]

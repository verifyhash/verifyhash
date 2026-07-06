"""einvoice — first-slice XRechnung / EN 16931 UBL Invoice validator.

Standard library only. See SPEC.md for scope.
"""

from .validate import validate_file, validate_root, Result  # noqa: F401
from .parser import NotWellFormed  # noqa: F401

__all__ = ["validate_file", "validate_root", "Result", "NotWellFormed"]

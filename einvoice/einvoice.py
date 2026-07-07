#!/usr/bin/env python3
"""einvoice — XRechnung / EN 16931 UBL Invoice validator (CLI wrapper).

This is the source-checkout convenience entry point; the real CLI lives in
the ``einvoice`` package (``einvoice/cli.py``) so the validator is
pip-installable (console script ``einvoice``) and runnable as
``python3 -m einvoice``. All three forms are the same code path:

    python3 einvoice.py validate <invoice.xml> [--json] [--profile=...]
    python3 -m einvoice validate <invoice.xml> [--json] [--profile=...]
    einvoice validate <invoice.xml> [--json] [--profile=...]   (pip-installed)

Exit codes (stable contract): 0 pass, 1 fatal rule failed, 2 usage error,
3 not well-formed XML. See ``einvoice/cli.py`` for the full contract.

Standard library only.
"""

import os
import sys

# Ensure the sibling `einvoice/` package is importable even if the script is
# invoked from another working directory. (The package directory shadows this
# same-named module — packages take import precedence.)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from einvoice.cli import main, EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE  # noqa: E402,F401

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

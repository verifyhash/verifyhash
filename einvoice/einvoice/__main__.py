"""`python3 -m einvoice` — module entry point (same CLI as `einvoice`)."""

import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main())

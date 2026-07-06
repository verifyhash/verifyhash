#!/usr/bin/env python3
"""einvoice — first-slice XRechnung / EN 16931 UBL Invoice validator (CLI).

Usage:
    python3 einvoice.py validate <invoice.xml> [--json]

Exit codes:
    0  the invoice passes every implemented rule
    1  at least one implemented rule failed
    2  usage error
    3  input is not well-formed XML / parse error

Default output on failure: the FIRST violated rule id, a human message and the
offending element. With --json, the full result (all violations) is emitted.

Standard library only.
"""

import json
import os
import sys

# Ensure the sibling `einvoice/` package is importable even if the script is
# invoked from another working directory.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from einvoice.validate import validate_file  # noqa: E402
from einvoice.parser import NotWellFormed     # noqa: E402

USAGE = "usage: python3 einvoice.py validate <invoice.xml> [--json]"

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_USAGE = 2
EXIT_PARSE = 3


def main(argv):
    args = list(argv)
    as_json = False
    if "--json" in args:
        as_json = True
        args = [a for a in args if a != "--json"]

    if len(args) < 2 or args[0] != "validate":
        sys.stderr.write(USAGE + "\n")
        return EXIT_USAGE
    if len(args) > 2:
        sys.stderr.write("error: unexpected extra arguments\n" + USAGE + "\n")
        return EXIT_USAGE

    path = args[1]
    if not os.path.isfile(path):
        sys.stderr.write("error: no such file: %s\n" % path)
        return EXIT_USAGE

    try:
        result = validate_file(path)
    except NotWellFormed as exc:
        if as_json:
            sys.stdout.write(json.dumps({
                "source": path,
                "valid": False,
                "error": "not-well-formed",
                "message": str(exc),
            }, indent=2) + "\n")
        else:
            sys.stderr.write("S-WF: input is not well-formed XML: %s\n" % exc)
        return EXIT_PARSE

    if as_json:
        sys.stdout.write(json.dumps(result.to_dict(source=path), indent=2) + "\n")
    else:
        if result.ok:
            sys.stdout.write("PASS: %s (all %d implemented rules)\n"
                             % (path, 20))
        else:
            v = result.first
            sys.stdout.write("FAIL: %s\n  %s: %s\n  offending element: %s\n"
                             % (path, v.rule_id, v.message, v.element))

    return EXIT_OK if result.ok else EXIT_FAIL


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

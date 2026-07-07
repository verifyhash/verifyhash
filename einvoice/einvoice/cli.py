"""Command-line interface for the einvoice validator.

Usage:
    einvoice validate <invoice.xml> [--json] [--profile=en16931|xrechnung]

(also reachable as ``python3 -m einvoice ...`` and, from a source checkout,
``python3 einvoice.py ...`` — all three are the same entry point.)

Profiles:
    en16931 (default)  the EN 16931 core business rules
    xrechnung          core rules PLUS the German national CIUS layer
                       (BR-DE-*). Warnings/information are reported, but only
                       *fatal* violations make the invoice invalid (exit 1) —
                       the official Schematron ``flag`` semantics.

Exit codes (stable contract):
    0  the invoice passes every implemented fatal rule
    1  at least one implemented fatal rule failed
    2  usage error
    3  input is not well-formed XML / parse error

Default output on failure: the FIRST fatal violated rule id, a human message
and the offending element. With --json, the full result (all violations,
each with its severity) is emitted.

Standard library only.
"""

import json
import os
import sys

from .validate import validate_file, PROFILES, _severity
from .parser import NotWellFormed

USAGE = ("usage: einvoice validate <invoice.xml> "
         "[--json] [--profile=en16931|xrechnung]")

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_USAGE = 2
EXIT_PARSE = 3


def main(argv=None):
    """Run the CLI. Returns the process exit code (see module docstring)."""
    if argv is None:
        argv = sys.argv[1:]
    args = list(argv)
    as_json = False
    if "--json" in args:
        as_json = True
        args = [a for a in args if a != "--json"]

    profile = "en16931"
    rest = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--profile":
            if i + 1 >= len(args):
                sys.stderr.write("error: --profile needs a value\n" + USAGE + "\n")
                return EXIT_USAGE
            profile = args[i + 1]
            i += 2
            continue
        if a.startswith("--profile="):
            profile = a.split("=", 1)[1]
            i += 1
            continue
        rest.append(a)
        i += 1
    args = rest
    if profile not in PROFILES:
        sys.stderr.write("error: unknown profile %r (choose from %s)\n%s\n"
                         % (profile, ", ".join(PROFILES), USAGE))
        return EXIT_USAGE

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
        result = validate_file(path, profile=profile)
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
            non_fatal = len(result.violations)
            suffix = (" — %d non-fatal warning(s) reported" % non_fatal
                      if non_fatal else "")
            sys.stdout.write("PASS: %s (all implemented fatal rules, "
                             "profile=%s)%s\n" % (path, profile, suffix))
        else:
            v = next(x for x in result.violations if _severity(x) == "fatal")
            sys.stdout.write("FAIL: %s\n  %s: %s\n  offending element: %s\n"
                             % (path, v.rule_id, v.message, v.element))

    return EXIT_OK if result.ok else EXIT_FAIL


if __name__ == "__main__":
    sys.exit(main())

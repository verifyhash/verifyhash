"""Command-line interface for the einvoice validator.

Usage:
    einvoice validate <invoice.xml> [--json] [--profile=en16931|xrechnung]
    einvoice receipt  <invoice.xml> [--profile=en16931|xrechnung]

(also reachable as ``python3 -m einvoice ...`` and, from a source checkout,
``python3 einvoice.py ...`` — all three are the same entry point.)

Subcommands:
    validate   report conformance (human summary, or --json full result).
    receipt    emit a CANONICAL, DETERMINISTIC JSON conformance receipt: a
               byte-stable attestation of the outcome (tool+version, profile,
               verdict, failed fatal rule ids, input-document SHA-256, and a
               SHA-256 content hash of the receipt body). Re-running on the
               same bytes yields byte-identical output — the tamper-evidence
               bridge. See ``einvoice/receipt.py``.

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
    3  input is not well-formed XML / parse error (``validate`` only; the
       ``receipt`` subcommand folds this into a FAIL receipt, exit 1)

Default output on failure: the FIRST fatal violated rule id, a human message
and the offending element. With --json, the full result (all violations,
each with its severity) is emitted.

Standard library only.
"""

import json
import os
import sys

from .validate import validate_file, PROFILES, _severity
from .parser import NotWellFormed, parse_file
from .receipt import build_receipt, canonical_json
from .report import syntax_binding_section

USAGE = ("usage: einvoice validate <invoice.xml> "
         "[--json] [--profile=en16931|xrechnung]\n"
         "       einvoice receipt <invoice.xml> "
         "[--profile=en16931|xrechnung]")

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

    if len(args) < 2 or args[0] not in ("validate", "receipt"):
        sys.stderr.write(USAGE + "\n")
        return EXIT_USAGE
    if len(args) > 2:
        sys.stderr.write("error: unexpected extra arguments\n" + USAGE + "\n")
        return EXIT_USAGE

    subcommand = args[0]
    path = args[1]
    if not os.path.isfile(path):
        sys.stderr.write("error: no such file: %s\n" % path)
        return EXIT_USAGE

    if subcommand == "receipt":
        # A conformance receipt always emits a canonical JSON document (the
        # receipt IS the output); the exit code mirrors the verdict so it can
        # gate a build. Not-well-formed input is folded into a FAIL receipt by
        # build_receipt, so nothing here raises NotWellFormed.
        receipt = build_receipt(path, profile=profile)
        sys.stdout.write(canonical_json(receipt) + "\n")
        return EXIT_OK if receipt["receipt"]["verdict"] == "PASS" else EXIT_FAIL

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

    # Surface the distinct 'syntax-binding' category (the UBL
    # absence-restriction / cardinality / existence asserts of
    # einvoice.syntax_binding_eval) via the SAME projection report.py uses —
    # reused verbatim, no evaluator re-implementation. These findings are
    # reported as WARNINGS and NEVER change `valid` or the process exit code:
    # exit stays driven solely by fatal business-rule violations, byte-identical
    # to today. validate_file already parsed this file cleanly above, so this
    # re-parse through the identical hardened parser cannot raise NotWellFormed.
    sb = syntax_binding_section(parse_file(path))

    if as_json:
        out = result.to_dict(source=path)
        # Adds the `syntax_bindings` array + its two count fields to the existing
        # result shape; the original keys and their values stay byte-identical.
        out.update(sb)
        sys.stdout.write(json.dumps(out, indent=2) + "\n")
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
        # Syntax-binding warnings are a separate, non-blocking category — print
        # the count on its own line so the exit-driving FAIL/PASS verdict above
        # stays unambiguous.
        sys.stdout.write("Syntax-binding warnings: %d\n"
                         % sb["syntax_binding_warning_count"])

    return EXIT_OK if result.ok else EXIT_FAIL


if __name__ == "__main__":
    sys.exit(main())

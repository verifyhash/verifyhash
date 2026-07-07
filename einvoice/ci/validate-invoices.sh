#!/bin/sh
# validate-invoices.sh — CI conformance gate for EN 16931 / XRechnung invoices.
#
# Fails the build (exit 1) if ANY invoice is non-conformant, printing the
# violated rule ID (e.g. BR-DE-15) for each failing invoice. Copy-paste into
# any CI system; POSIX sh, no bash-isms, no dependencies beyond python3.
#
# Usage:
#   sh ci/validate-invoices.sh <file-or-dir> [<file-or-dir> ...]
#     Directories are searched recursively for *.xml.
#
# Environment:
#   EINVOICE_PROFILE      validation profile: xrechnung (default) | en16931
#   EINVOICE_CMD          override the validator command, e.g.
#                         "python3 /path/to/einvoice.py" (word-split on
#                         purpose). Default resolution order:
#                           1. $EINVOICE_CMD
#                           2. `einvoice` on PATH (pip-installed)
#                           3. `python3 -m einvoice` (package importable)
#   EINVOICE_ALLOW_EMPTY  set to 1 to pass when no *.xml files are found
#                         (default: an empty gate is a broken gate -> exit 2)
#
# Exit codes:
#   0  every invoice passed every implemented fatal rule
#   1  at least one invoice is non-conformant (rule IDs printed) or unreadable
#   2  gate misconfigured (no validator, no input files, bad usage)

set -u

PROFILE="${EINVOICE_PROFILE:-xrechnung}"

if [ "$#" -lt 1 ]; then
    echo "usage: $0 <file-or-dir> [<file-or-dir> ...]" >&2
    exit 2
fi

# --- resolve the validator ------------------------------------------------
if [ -n "${EINVOICE_CMD:-}" ]; then
    RUNNER="$EINVOICE_CMD"
elif command -v einvoice >/dev/null 2>&1; then
    RUNNER="einvoice"
elif python3 -c "import einvoice.cli" >/dev/null 2>&1; then
    RUNNER="python3 -m einvoice"
else
    echo "error: no einvoice validator found." >&2
    echo "  install it (python3 -m pip install /path/to/einvoice)," >&2
    echo "  or set EINVOICE_CMD=\"python3 /path/to/einvoice.py\"" >&2
    exit 2
fi

# --- collect the invoice files ---------------------------------------------
LIST="$(mktemp)" || exit 2
trap 'rm -f "$LIST"' EXIT

for arg in "$@"; do
    if [ -d "$arg" ]; then
        find "$arg" -type f -name '*.xml' >> "$LIST"
    elif [ -f "$arg" ]; then
        printf '%s\n' "$arg" >> "$LIST"
    else
        echo "error: no such file or directory: $arg" >&2
        exit 2
    fi
done

sort "$LIST" -o "$LIST"
TOTAL=$(wc -l < "$LIST" | tr -d ' ')

if [ "$TOTAL" -eq 0 ]; then
    if [ "${EINVOICE_ALLOW_EMPTY:-0}" = "1" ]; then
        echo "conformance gate: no *.xml invoices found (EINVOICE_ALLOW_EMPTY=1) — pass"
        exit 0
    fi
    echo "error: no *.xml invoices found under: $*" >&2
    echo "  (a gate that checks nothing proves nothing; set EINVOICE_ALLOW_EMPTY=1 to allow)" >&2
    exit 2
fi

# --- validate each invoice --------------------------------------------------
FAILED=0
while IFS= read -r f; do
    # $RUNNER is word-split on purpose (it may be "python3 -m einvoice").
    OUT=$($RUNNER validate "$f" --profile "$PROFILE" 2>&1)
    CODE=$?
    case "$CODE" in
        0)  ;;                      # conformant
        1|3)                        # rule violation / not well-formed XML
            FAILED=$((FAILED + 1))
            printf '%s\n' "$OUT"    # names the violated rule ID (or S-WF)
            ;;
        *)                          # usage error etc. = the gate itself is broken
            printf '%s\n' "$OUT" >&2
            echo "error: validator exited $CODE on $f — gate misconfigured" >&2
            exit 2
            ;;
    esac
done < "$LIST"

if [ "$FAILED" -gt 0 ]; then
    echo "conformance gate: $FAILED/$TOTAL invoice(s) NON-CONFORMANT (profile=$PROFILE) — FAIL"
    exit 1
fi
echo "conformance gate: $TOTAL/$TOTAL invoice(s) conformant (profile=$PROFILE, implemented rules only) — PASS"
exit 0

#!/bin/sh
# validate-invoices.sh — CI conformance gate for EN 16931 / XRechnung invoices.
#
# Drives the REAL conformance-report entrypoint `python3 -m einvoice.report`
# (json/junit, versioned schema) — NOT the legacy single-invoice validate CLI.
# For every *.xml invoice it writes a per-invoice JUnit report (so your CI can
# render/upload it as a test report) and fails the build (exit 1) if ANY
# invoice has a FATAL violation, printing the violated rule ID (e.g. BR-DE-15)
# for each failing invoice. Copy-paste into any CI system; POSIX sh, no
# bash-isms, no dependencies beyond python3.
#
# Usage:
#   sh ci/validate-invoices.sh <file-or-dir> [<file-or-dir> ...]
#     Directories are searched recursively for *.xml.
#
# Environment:
#   EINVOICE_PROFILE      validation profile: xrechnung (default) | en16931
#   EINVOICE_CMD          override the report command, e.g.
#                         "python3 -m einvoice.report" (word-split on purpose).
#                         It MUST invoke the report entrypoint — the gate
#                         appends `--profile <p> --format junit <file>` to it.
#                         Default resolution order:
#                           1. $EINVOICE_CMD
#                           2. `python3 -m einvoice.report` (package importable)
#   EINVOICE_RESULTS_DIR  where to write the per-invoice JUnit XML files. When
#                         set, the files are KEPT (point your CI's test-report
#                         upload at this dir). When unset, a throwaway temp dir
#                         is used and removed on exit.
#   EINVOICE_ALLOW_EMPTY  set to 1 to pass when no *.xml files are found
#                         (default: an empty gate is a broken gate -> exit 2)
#
# Exit codes (mirror the report entrypoint's 0 = no fatal / non-zero = fatal):
#   0  every invoice passed every implemented FATAL rule
#   1  at least one invoice has a fatal violation (rule IDs printed) or is not
#      well-formed XML
#   2  gate misconfigured (no validator, no input files, bad usage/profile)
#
# Adoption on-ramp: to gate only on NEW regressions vs a captured baseline
# (tolerating a pre-existing backlog) use the report entrypoint's `--baseline`
# mode directly instead of this hard gate — see ci/README.md and T-VH.22:
#   python3 -m einvoice.report --format json invoice.xml > baseline.json
#   python3 -m einvoice.report --baseline baseline.json invoice.xml

set -u

PROFILE="${EINVOICE_PROFILE:-xrechnung}"

case "$PROFILE" in
    xrechnung|en16931) ;;
    *)
        echo "error: EINVOICE_PROFILE must be 'xrechnung' or 'en16931' (got: $PROFILE)" >&2
        exit 2
        ;;
esac

if [ "$#" -lt 1 ]; then
    echo "usage: $0 <file-or-dir> [<file-or-dir> ...]" >&2
    exit 2
fi

# --- resolve the report entrypoint ----------------------------------------
if [ -n "${EINVOICE_CMD:-}" ]; then
    RUNNER="$EINVOICE_CMD"
elif python3 -c "import einvoice.report" >/dev/null 2>&1; then
    RUNNER="python3 -m einvoice.report"
else
    echo "error: the einvoice.report entrypoint is not importable." >&2
    echo "  install the validator (python3 -m pip install /path/to/einvoice)," >&2
    echo "  run from the vendored source dir, or set" >&2
    echo "  EINVOICE_CMD=\"python3 -m einvoice.report\" with PYTHONPATH set." >&2
    exit 2
fi

# --- scratch space (input list, JUnit results dir, stderr capture) ---------
LIST="$(mktemp)" || exit 2
ERRTMP="$(mktemp)" || { rm -f "$LIST"; exit 2; }

CLEAN_RESULTS=0
if [ -n "${EINVOICE_RESULTS_DIR:-}" ]; then
    RESULTS_DIR="$EINVOICE_RESULTS_DIR"
else
    RESULTS_DIR="$(mktemp -d)" || { rm -f "$LIST" "$ERRTMP"; exit 2; }
    CLEAN_RESULTS=1
fi
mkdir -p "$RESULTS_DIR" 2>/dev/null || {
    echo "error: cannot create results dir: $RESULTS_DIR" >&2
    rm -f "$LIST" "$ERRTMP"
    exit 2
}

cleanup() {
    rm -f "$LIST" "$ERRTMP"
    [ "$CLEAN_RESULTS" = 1 ] && rm -rf "$RESULTS_DIR"
    return 0
}
trap cleanup EXIT

# --- collect the invoice files ---------------------------------------------
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

# --- validate each invoice via the report entrypoint (JUnit projection) ----
FAILED=0
N=0
while IFS= read -r f; do
    N=$((N + 1))
    # Stable, collision-free result filename for this invoice.
    SAFE=$(printf '%s' "$f" | tr -c 'A-Za-z0-9._-' '_')
    RESULT="$RESULTS_DIR/${N}_${SAFE}.junit.xml"

    # $RUNNER is word-split on purpose (it may be "python3 -m einvoice.report").
    # JUnit XML -> per-invoice result file; the exit code gates the build.
    $RUNNER --profile "$PROFILE" --format junit "$f" > "$RESULT" 2>"$ERRTMP"
    CODE=$?
    case "$CODE" in
        0)  ;;                      # no fatal violation — conformant
        1|3)                        # fatal violation (1) / not well-formed XML (3)
            FAILED=$((FAILED + 1))
            echo "FAIL: $f"
            # Name each fatal rule id (or 'not-well-formed') from the JUnit doc.
            awk -F'"' '
                /<testcase name=/  { rule = $2 }
                /<failure/         { print "  " rule }
                /<error/           { print "  " rule " (not well-formed XML)" }
            ' "$RESULT"
            echo "  JUnit: $RESULT"
            ;;
        *)                          # usage/config error = the gate itself is broken
            cat "$ERRTMP" >&2
            echo "error: report entrypoint exited $CODE on $f — gate misconfigured" >&2
            exit 2
            ;;
    esac
done < "$LIST"

if [ "$FAILED" -gt 0 ]; then
    echo "conformance gate: $FAILED/$TOTAL invoice(s) NON-CONFORMANT (profile=$PROFILE) — FAIL"
    [ "$CLEAN_RESULTS" = 0 ] && echo "  JUnit reports written to: $RESULTS_DIR"
    exit 1
fi
echo "conformance gate: $TOTAL/$TOTAL invoice(s) conformant (profile=$PROFILE, implemented rules only) — PASS"
[ "$CLEAN_RESULTS" = 0 ] && echo "  JUnit reports written to: $RESULTS_DIR"
exit 0

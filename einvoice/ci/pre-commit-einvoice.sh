#!/bin/sh
# pre-commit-einvoice.sh — local git pre-commit hook that gates STAGED invoice
# XML through the REAL EN 16931 / XRechnung conformance entrypoint
# (`python3 -m einvoice.report`) and BLOCKS the commit if any staged invoice
# has a FATAL violation. It is the same validator the CI gate
# (validate-invoices.sh) drives, just wired to the commit boundary so a bad
# invoice never reaches the branch in the first place.
#
# It NEVER re-implements validation: it shells out to the report entrypoint and
# reuses that entrypoint's own exit-code contract:
#   0            invoice passed every implemented FATAL rule
#   1 (non-zero) at least one FATAL violation (rule IDs printed, commit blocked)
#   3 (non-zero) input is not well-formed XML (commit blocked)
#
# Usage:
#   As a git hook — copy this file to .git/hooks/pre-commit (chmod +x) or wire
#   it through the pre-commit framework (see ci/.pre-commit-config.yaml). With
#   no arguments it validates the *.xml files that are STAGED for this commit
#   (git diff --cached, added/copied/modified only).
#
#   Standalone / testable — pass explicit files (so you can exercise it without
#   an actual commit):
#     sh ci/pre-commit-einvoice.sh path/to/a.xml path/to/b.xml
#
# Nothing is installed automatically; a repo only gets this hook if a developer
# opts in by copying/wiring it. On a commit that stages no invoice XML the hook
# is inert and exits 0.
#
# Environment (same override convention as validate-invoices.sh):
#   EINVOICE_PROFILE  validation profile: xrechnung (default) | en16931
#   EINVOICE_CMD      override the report command (word-split on purpose); it
#                     MUST invoke the report entrypoint — the hook appends
#                     `--profile <p> --format junit <file>`. Default resolution:
#                       1. $EINVOICE_CMD
#                       2. `python3 -m einvoice.report` (package importable)

set -u

PROFILE="${EINVOICE_PROFILE:-xrechnung}"

case "$PROFILE" in
    xrechnung|en16931) ;;
    *)
        echo "error: EINVOICE_PROFILE must be 'xrechnung' or 'en16931' (got: $PROFILE)" >&2
        exit 2
        ;;
esac

# --- collect the invoice files --------------------------------------------
# Explicit args win (testability); otherwise ask git for the staged XML.
LIST="$(mktemp)" || exit 2
JUNIT="$(mktemp)" || { rm -f "$LIST"; exit 2; }
ERRTMP="$(mktemp)" || { rm -f "$LIST" "$JUNIT"; exit 2; }

cleanup() {
    rm -f "$LIST" "$JUNIT" "$ERRTMP"
    return 0
}
trap cleanup EXIT

if [ "$#" -ge 1 ]; then
    for arg in "$@"; do
        case "$arg" in
            *.xml|*.XML) printf '%s\n' "$arg" >> "$LIST" ;;
        esac
    done
elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    # Added / Copied / Modified staged files only (never deletions/renamed-away).
    git diff --cached --name-only --diff-filter=ACM 2>/dev/null \
        | grep -i '\.xml$' >> "$LIST" 2>/dev/null || true
fi

TOTAL=0
if [ -s "$LIST" ]; then
    TOTAL=$(wc -l < "$LIST" | tr -d ' ')
fi

# No invoice XML staged/passed — the hook is inert on unrelated commits.
if [ "$TOTAL" -eq 0 ]; then
    exit 0
fi

# --- resolve the report entrypoint (only now that there is work to do) -----
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

# --- validate each staged invoice via the report entrypoint ----------------
FAILED=0
while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ ! -f "$f" ]; then
        echo "error: staged invoice not found on disk: $f" >&2
        exit 2
    fi

    # $RUNNER is word-split on purpose (it may be "python3 -m einvoice.report").
    # JUnit projection lets us name the offending rule id(s); the exit code
    # (not the parse) is what gates the commit.
    $RUNNER --profile "$PROFILE" --format junit "$f" > "$JUNIT" 2>"$ERRTMP"
    CODE=$?
    case "$CODE" in
        0)  ;;                      # conformant — no fatal violation
        1|3)                        # fatal violation (1) / not well-formed XML (3)
            FAILED=$((FAILED + 1))
            echo "BLOCKED: $f"
            awk -F'"' '
                /<testcase name=/  { rule = $2 }
                /<failure/         { print "  " rule }
                /<error/           { print "  " rule " (not well-formed XML)" }
            ' "$JUNIT"
            ;;
        *)                          # usage/config error = the hook is broken
            cat "$ERRTMP" >&2
            echo "error: report entrypoint exited $CODE on $f — hook misconfigured" >&2
            exit 2
            ;;
    esac
done < "$LIST"

if [ "$FAILED" -gt 0 ]; then
    echo "einvoice pre-commit: $FAILED/$TOTAL staged invoice(s) NON-CONFORMANT (profile=$PROFILE) — commit blocked" >&2
    echo "  fix the rule(s) above, or run 'git commit --no-verify' to bypass (not recommended)." >&2
    exit 1
fi
exit 0

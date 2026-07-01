#!/usr/bin/env bash
# verify-service.generic.sh — a portable, copy-paste CI MERGE GATE that calls the `vh serve-verify` HTTP
# endpoint (T-59.3).
#
# WHAT THIS IS
#   Drop this into ANY CI that can run a shell step (GitLab CI, CircleCI, Jenkins, a Makefile recipe, a
#   git pre-push hook). Instead of shelling out to the `vh` binary per-artifact, it POSTs a prepared verify
#   REQUEST BODY to a BOOTED `vh serve-verify` service and FAILS THE BUILD (non-zero exit) unless the
#   service answers 200 ACCEPTED. A tampered / forged / unknown seal answers 422 / 400 / 413 and the gate
#   exits non-zero — so the merge is blocked. A green pipeline now MEANS "the verify service ACCEPTED every
#   sealed artifact."
#
# WHY A SHELL SNIPPET (not just the curl call)
#   `set -e` + an explicit HTTP-status passthrough is the difference between a gate that BLOCKS a merge and
#   a step that prints red but still lets the pipeline go green. This wrapper makes the failure path the
#   DEFAULT: anything other than 200 ACCEPTED from the service becomes a non-zero exit of this script, which
#   every CI treats as a failed job.
#
# HOW THE REQUEST BODY IS PRODUCED (out of band — this gate does not build it)
#   The request body is the exact JSON the service expects (see docs/VERIFY-SERVICE.md), e.g.
#     { "kind": "verify-seal", "seal": <seal-object-or-json-string>,
#       "entries": [ { "relPath": "dist/app.js", "content": "<base64>", "encoding": "base64" } ] }
#   Produce it however your release flow does (the SDK's buildSeal/serializeSeal, or your own tooling) and
#   hand its PATH to this gate. This keeps the gate a pure, dependency-light HTTP client.
#
# DEPENDENCIES
#   `curl` and a POSIX shell. NOTHING ELSE — no node, no ethers, no hardhat in the gate itself (the SERVICE
#   is booted separately; see verify-service.github-actions.yml for a full boot+gate recipe).
#
# CONFIGURE VIA ENVIRONMENT (so this file is literal copy-paste; no in-file editing required):
#   VH_VERIFY_URL    base URL of the booted service   (default: http://127.0.0.1:4180)
#   VH_REQUEST       path to the verify request-body JSON file   (REQUIRED)
#
# EXIT CODES (so the job status is meaningful):
#   0  ACCEPTED  — HTTP 200; the service verified the seal; allow the merge.
#   3  REJECTED  — HTTP 422; a well-formed request that did NOT verify (tamper/forge/wrong signer); BLOCK.
#   2  BAD_REQ   — HTTP 400/413; the request itself was malformed/unknown/too large; BLOCK (never a pass).
#   1  IO        — the service was unreachable or the request file was missing; never reported as "passed".
#
# Usage:
#   VH_VERIFY_URL=http://127.0.0.1:4180 VH_REQUEST=./verify-request.json ./verify-service.generic.sh
set -euo pipefail

VH_VERIFY_URL="${VH_VERIFY_URL:-http://127.0.0.1:4180}"

if [ -z "${VH_REQUEST:-}" ]; then
  echo "verify-service CI gate: set VH_REQUEST to the path of the verify request-body JSON file." >&2
  exit 2
fi
if [ ! -f "$VH_REQUEST" ]; then
  echo "verify-service CI gate: request file not found: $VH_REQUEST" >&2
  exit 1
fi

# POST the request body to /verify. `-w` appends the HTTP status on its own trailing line so we can read it
# WITHOUT a JSON parser; `-s -S` stays quiet but still prints transport errors; `--fail` is NOT used (we want
# the body + status even on a 4xx so we can report the verdict). A connection failure makes curl exit
# non-zero, which we map to the IO(1) class rather than a silent pass.
set +e
RESPONSE="$(curl -s -S -o - -w $'\n%{http_code}' \
  -H 'content-type: application/json' \
  --data-binary "@${VH_REQUEST}" \
  "${VH_VERIFY_URL%/}/verify")"
curl_code=$?
set -e

if [ "$curl_code" -ne 0 ]; then
  echo "verify-service CI gate: could not reach ${VH_VERIFY_URL} (curl exit ${curl_code})." >&2
  exit 1
fi

# The last line is the HTTP status; everything before it is the JSON verdict body.
http_status="$(printf '%s\n' "$RESPONSE" | tail -n1)"
body="$(printf '%s\n' "$RESPONSE" | sed '$d')"

echo "verify-service CI gate: ${VH_VERIFY_URL%/}/verify -> HTTP ${http_status}"
echo "$body"

case "$http_status" in
  200)
    echo "verify-service CI gate: ACCEPTED — allowing the merge." >&2
    exit 0
    ;;
  422)
    echo "verify-service CI gate: REJECTED (HTTP 422) — blocking the merge." >&2
    exit 3
    ;;
  400 | 413)
    echo "verify-service CI gate: BAD REQUEST (HTTP ${http_status}) — blocking the merge." >&2
    exit 2
    ;;
  *)
    echo "verify-service CI gate: unexpected HTTP ${http_status} — blocking the merge." >&2
    exit 1
    ;;
esac

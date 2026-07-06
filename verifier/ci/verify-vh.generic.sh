#!/usr/bin/env bash
# verify-vh.generic.sh — a portable, copy-paste CI MERGE GATE for verifyhash artifacts.
#
# WHAT THIS IS
#   Drop this into ANY CI that can run a shell step (GitLab CI, CircleCI, Jenkins, a Makefile recipe,
#   a git pre-push hook, a bare cron box). It runs the STANDALONE, OFFLINE `verify-vh` verifier over a
#   release's artifact(s) and FAILS THE BUILD (non-zero exit) the instant any artifact is tampered,
#   forged, or signed by the wrong key. A green pipeline now MEANS "every sealed artifact still matches
#   the bytes the producer signed."
#
# WHY A SHELL SNIPPET (not just the node call)
#   `set -e` + an explicit exit-code passthrough is the difference between a gate that BLOCKS a merge
#   and a step that prints red but still lets the pipeline go green. This wrapper makes the failure
#   path the DEFAULT: any non-zero verdict from verify-vh becomes a non-zero exit of this script, which
#   every CI treats as a failed job.
#
# DEPENDENCIES
#   Node >= 18 and the standalone `verifier/` tree (verify-vh.js + lib/ + js-sha3). NOTHING ELSE — no
#   ethers, no hardhat, no network. See verifier/README.md to vendor or `npm install` just this tree.
#
# CONFIGURE VIA ENVIRONMENT (so this file is literal copy-paste; no in-file editing required):
#   VERIFY_VH       path to verify-vh.js               (default: ./verifier/verify-vh.js)
#   VH_VENDOR       producer signer address 0x..(20B)  (REQUIRED — pin who is allowed to have signed)
#   VH_MANIFEST     a release manifest file            (gate EVERY artifact in one shot; optional)
#   VH_ARTIFACTS    space-separated artifact paths     (used when VH_MANIFEST is unset)
#   VH_DIR          dir holding the referenced files   (optional; defaults to each artifact's own dir)
#
# PINNED + STRICT BY DEFAULT (T-75.2). This gate REQUIRES VH_VENDOR and passes `--strict`, so a green
#   job means ACCEPT-AND-PINNED: every artifact's bytes re-derive AND its signature recovers to the
#   vendor key YOU pinned (obtained out-of-band, never read off the artifact). Without a pin, a signed
#   artifact is accepted on its OWN self-asserted key — an attacker who re-signs a tampered release
#   with THEIR OWN key would pass — so `--strict` fails closed (exit 4, verdict UNPINNED) instead of
#   ever letting an unpinned accept read as provenance. Do not remove the pin or the flag.
#
# EXIT CODES (passed straight through from verify-vh, so the job status is meaningful):
#   0  OK        — every artifact verified AND was pinned to VH_VENDOR (ACCEPT-and-pinned); allow the merge.
#   3  REJECTED  — an artifact was tampered/forged/wrong-issuer; BLOCK the merge (report names which).
#   4  UNPINNED  — an artifact's bytes verified but NO trusted vendor pin backed the accept (--strict
#                  fail-closed); BLOCK the merge — anyone's key passes an unpinned check.
#   2  USAGE     — misconfiguration (bad flag / bad address / empty manifest).
#   1  IO        — an artifact or the manifest could not be read; never reported as "passed".
#
# Usage:
#   VH_VENDOR=0xabc... VH_ARTIFACTS="dist/a.vhevidence.json" ./verify-vh.generic.sh
#   VH_VENDOR=0xabc... VH_MANIFEST=release.manifest         ./verify-vh.generic.sh
set -euo pipefail

VERIFY_VH="${VERIFY_VH:-./verifier/verify-vh.js}"

if [ -z "${VH_VENDOR:-}" ]; then
  echo "verify-vh CI gate: set VH_VENDOR to the producer's signer address (0x + 20 bytes)." >&2
  exit 2
fi

# Build the verify-vh argument list. A MANIFEST gates the whole release in one invocation; otherwise we
# pass the artifact list positionally. Either way it is ONE call -> ONE exit code the CI gates on.
set -- # reset positional params we will hand to verify-vh
if [ -n "${VH_MANIFEST:-}" ]; then
  set -- --manifest "$VH_MANIFEST"
else
  if [ -z "${VH_ARTIFACTS:-}" ]; then
    echo "verify-vh CI gate: set VH_MANIFEST or VH_ARTIFACTS (the artifact(s) to verify)." >&2
    exit 2
  fi
  # shellcheck disable=SC2086  # word-splitting VH_ARTIFACTS into separate args is intentional.
  set -- $VH_ARTIFACTS
fi

# PINNED + STRICT: the pin says WHO must have signed; --strict guarantees a green exit can only ever
# mean ACCEPT-AND-PINNED (an unpinned accept is the distinct exit 4, never a silent pass).
set -- "$@" --vendor "$VH_VENDOR" --strict
if [ -n "${VH_DIR:-}" ]; then
  set -- "$@" --dir "$VH_DIR"
fi

# Run the gate. `set -e` would abort on the non-zero exit before we could echo a clear message, so we
# capture the code explicitly and pass it through verbatim — preserving the 0/3/4/2/1 contract for CI.
set +e
node "$VERIFY_VH" "$@"
code=$?
set -e

if [ "$code" -ne 0 ]; then
  echo "verify-vh CI gate: FAILED (exit $code) — blocking the merge." >&2
fi
exit "$code"

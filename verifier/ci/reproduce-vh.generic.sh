#!/usr/bin/env bash
# reproduce-vh.generic.sh — a portable, copy-paste CI gate that answers "WHO VERIFIES THE VERIFIER?"
# on EVERY build, by reproducing the standalone verifier byte-for-byte from the source you audited.
#
# WHAT THIS IS (and why it is different from verify-vh.generic.sh)
#   verify-vh.generic.sh gates your SEALS — it fails the build when a sealed artifact is tampered.
#   THIS gate watches the VERIFIER ITSELF. A security/procurement reviewer who audited the standalone
#   verifier once does not want to re-audit it by hand on every release; they want a pinned, automatable
#   control that re-confirms — offline, with no network, trusting no checksum we ship — that the
#   committed `verify-vh-standalone.js` / `seal-vh-standalone.js` bundles, their `.sha256` sidecars, the
#   build-provenance manifest, AND every inlined `lib/*.js` source file STILL reproduce byte-for-byte
#   from the in-tree source they read. The instant a supply-chain swap, a stale bundle, or a one-byte
#   source edit slips in, `node build-standalone.js --check` exits non-zero and THIS gate FAILS THE BUILD.
#
#   This turns the §0b "reproduce-from-source" answer from a one-time read into a RENEWING dependency:
#   a green pipeline now MEANS "the verifier we depend on is still the source we audited."
#
# WHY A SHELL SNIPPET (not just the node call)
#   `set -e` + an explicit exit-code passthrough is the difference between a gate that BLOCKS a merge
#   and a step that prints red but lets the pipeline go green. Any non-zero verdict from `--check`
#   becomes a non-zero exit of this script, which every CI treats as a failed job.
#
# DEPENDENCIES
#   Node >= 18 and the in-tree `verifier/` source (build-standalone.js + lib/ + dist/). NOTHING ELSE —
#   no `npm install`, no ethers, no hardhat, no network. `--check` is read-only: it writes nothing.
#
# CONFIGURE VIA ENVIRONMENT (so this file is literal copy-paste; no in-file editing required):
#   BUILD_STANDALONE   path to build-standalone.js   (default: ./verifier/build-standalone.js)
#
# EXIT CODES (passed straight through from `--check`, so the job status is meaningful):
#   0  ALL MATCH   — every bundle, sidecar, manifest AND inlined source reproduces; the verifier is the
#                    source you audited. Allow the merge.
#   1  MISMATCH    — something does NOT reproduce (the report NAMES the offending bundle/sidecar/manifest
#                    or the exact lib/*.js source file); BLOCK the merge and distrust this checkout.
#
# Usage:
#   ./reproduce-vh.generic.sh
#   BUILD_STANDALONE=path/to/verifier/build-standalone.js ./reproduce-vh.generic.sh
set -euo pipefail

BUILD_STANDALONE="${BUILD_STANDALONE:-./verifier/build-standalone.js}"

if [ ! -f "$BUILD_STANDALONE" ]; then
  echo "reproduce-vh CI gate: build-standalone.js not found at '$BUILD_STANDALONE'." >&2
  echo "  Set BUILD_STANDALONE to the path of verifier/build-standalone.js in your checkout." >&2
  exit 1
fi

# Run the read-only reproduce-and-attest pass. `set -e` would abort on the non-zero exit before we could
# echo a clear message, so we capture the code explicitly and pass it through verbatim.
set +e
node "$BUILD_STANDALONE" --check
code=$?
set -e

if [ "$code" -ne 0 ]; then
  echo "reproduce-vh CI gate: FAILED (exit $code) — the verifier does NOT reproduce from source; blocking the merge." >&2
fi
exit "$code"

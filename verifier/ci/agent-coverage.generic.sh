#!/usr/bin/env bash
# agent-coverage.generic.sh — a portable, copy-paste CI FLEET-COVERAGE gate built on
# `vh agent coverage` (T-71.2, EPIC-71 "AgentTrace coverage").
#
# WHAT THIS IS
#   Drop this into ANY CI that can run a shell step (GitLab CI, CircleCI, Jenkins, a Makefile recipe,
#   a git pre-push hook). It asks ONE question about the pushed commit range: "does EVERY commit carry
#   a verifiable agent-session record?" — and FAILS THE BUILD (non-zero exit) when one does not. Under
#   the hood `vh agent coverage` enumerates the range OLDEST-FIRST (git rev-list --reverse), FULLY
#   verifies every *.vhagent.json packet under $VH_PACKETS through the SAME verify path as
#   `vh agent verify`, extracts each packet's disclosed commit-claims, and gates on the policy:
#   a commit with no claim from a VERIFIED packet blocks the merge.
#
# WHY A POLICY GATE (not just a report)
#   The report alone tells you coverage after the fact; the gate makes the paved road the DEFAULT:
#   a change that ships without a sealed session record turns the pipeline red at the commit that
#   lacks it, named by oid. An unverifiable (tampered/forged) packet NEVER counts as coverage — its
#   claims are counted only as `claim-unverified-packet` and the packet is NAMED in the report.
#
# TRUST BOUNDARY (this gate will not let you overclaim)
#   Coverage is an INVENTORY control, NOT an authorship detector: a covered commit means an UNALTERED
#   sealed session CONTAINS a disclosed claim naming exactly that commit oid — CONTAINMENT, not causation;
#   it does NOT prove the session's events PRODUCED the commit, and an uncovered commit
#   proves NOTHING about how it was authored. Event `ts` fields are SELF-ASSERTED, and nothing here is
#   a trusted timestamp (STRATEGY.md P-3). With VH_DEEP=1 each claimed commit's tracked-set root is
#   additionally RE-DERIVED (the `vh hash --git` engine) in a throwaway LOCAL clone — offline, removed
#   on every exit path — so a lying gitRoot surfaces as the NAMED `claim-root-mismatch`; without it a
#   verified claim is `covered-oid-only` (root not re-derived — the output says so).
#
# DEPENDENCIES
#   The full verifyhash package (from `npm i verifyhash` / `npx vh`, which brings in ethers as a
#   runtime dependency), `git`, and a POSIX shell — no hardhat (a devDep, never installed for
#   consumers) and NO NETWORK (rev-list, packet verify, and the --deep local-path clone are all
#   pure-local operations).
#   INDEPENDENCE NOTE: unlike the ZERO-DEPENDENCY standalone `verify-vh` bundle in verifier/ (which
#   vendors its own keccak and needs no ethers), THIS coverage gate runs the PRODUCER package and is
#   NOT part of the zero-install independent verifier — range enumeration (`git rev-list`), commit-claim
#   extraction, and (with --deep) hashGit tracked-set root re-derivation do not live in the standalone.
#   The PACKET-verification leg IS independently checkable with the standalone bundle
#   (verifier/README.md §2c), but the coverage gate AS A WHOLE is producer-stack. See
#   verifier/README.md §6 ("Why you can trust this verifier itself") for the standalone's independence
#   scope.
#
# CONFIGURE VIA ENVIRONMENT (so this file is literal copy-paste; no in-file editing required):
#   VH_BIN            the `vh` command                    (default: vh — on PATH via npm; or a path)
#   VH_REPO           the git work tree to enumerate       (default: .)
#   VH_RANGE          the rev-range to gate                (REQUIRED; e.g. origin/main..HEAD)
#   VH_PACKETS        dir holding the *.vhagent.json packets (REQUIRED)
#   VH_DEEP           "1" => --deep root re-derivation     (default: 0 — oid-only)
#   VH_REQUIRE_ALL    "1" => --require-all                 (default: 1; set "0" for report-only)
#   VH_REQUIRE_SINCE  an oid/ref => --require-since <oid>  (optional; takes precedence over
#                                                           VH_REQUIRE_ALL when set)
#   VH_OUT            path to write the canonical vh-agent-coverage@1 report (optional; byte-diffable
#                                                           and sealable with `vh evidence seal`)
#
# EXIT CODES (passed straight through from `vh agent coverage`, so the job status is meaningful):
#   0  PASS      — every required commit carries a verifiable claim (or report-only mode); allow.
#   3  GATE-FAIL — a required commit lacks a verifiable claim (uncovered, unverifiable packet, or a
#                  --deep root mismatch); BLOCK the merge.
#   2  USAGE     — misconfiguration (missing env, unknown --range); never reported as "passed".
#   1  IO        — a file/clone problem; never reported as "passed".
#
# Usage:
#   VH_RANGE=origin/main..HEAD VH_PACKETS=./.vhagent ./agent-coverage.generic.sh
set -euo pipefail

VH_BIN="${VH_BIN:-vh}"
VH_REPO="${VH_REPO:-.}"

if [ -z "${VH_RANGE:-}" ]; then
  echo "agent-coverage CI gate: set VH_RANGE to the rev-range to gate (e.g. origin/main..HEAD)." >&2
  exit 2
fi
if [ -z "${VH_PACKETS:-}" ]; then
  echo "agent-coverage CI gate: set VH_PACKETS to the directory holding the sealed *.vhagent.json packets." >&2
  exit 2
fi

set -- agent coverage --repo "$VH_REPO" --range "$VH_RANGE" --packets "$VH_PACKETS"
if [ "${VH_DEEP:-0}" = "1" ]; then set -- "$@" --deep; fi
if [ -n "${VH_REQUIRE_SINCE:-}" ]; then
  set -- "$@" --require-since "$VH_REQUIRE_SINCE"
elif [ "${VH_REQUIRE_ALL:-1}" = "1" ]; then
  set -- "$@" --require-all
fi
if [ -n "${VH_OUT:-}" ]; then set -- "$@" --out "$VH_OUT"; fi

# THE GATE. The exit code is `vh agent coverage`'s own shared contract, passed straight through so
# the CI job status is meaningful (0 pass / 3 gate-fail / 2 usage / 1 IO).
set +e
"$VH_BIN" "$@"
code=$?
set -e

if [ "$code" -ne 0 ]; then
  echo "agent-coverage CI gate: FAILED (exit $code) — a commit in $VH_RANGE lacks a verifiable agent-session claim (or the run could not complete); blocking the merge." >&2
fi
exit "$code"

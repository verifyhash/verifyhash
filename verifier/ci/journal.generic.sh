#!/usr/bin/env bash
# journal.generic.sh — a portable, copy-paste CI CONTINUOUS-INTEGRITY gate built on the `vh journal`
# append-only, hash-chained integrity journal (T-60.3).
#
# WHAT THIS IS
#   Drop this into ANY CI that can run a shell step (GitLab CI, CircleCI, Jenkins, a Makefile recipe, a
#   git pre-push hook, a bare cron box). On every run it APPENDS this build's verify verdict to a STANDING
#   append-only journal, then VERIFIES the whole chain and FAILS THE BUILD (non-zero exit) unless the chain
#   is UNBROKEN and every recorded observation was ACCEPTED. Unlike a one-shot verify (does it match RIGHT
#   NOW?), a green pipeline here MEANS "the artifact has verified CONTINUOUSLY across every recorded run, and
#   the record itself is tamper-evident" — the standing, re-runnable integrity trail a one-shot verify cannot
#   produce.
#
# WHY APPEND-THEN-VERIFY (the continuous-integrity shape)
#   `vh journal append` records THIS run's verdict as ONE new hash-chained line — STRICTLY ADDITIVELY (prior
#   lines are never rewritten). Recording a REJECTED verdict is a SUCCESSFUL append (the journal's job is to
#   faithfully record what it saw); the drift then surfaces at `vh journal verify` time. So the gate's verdict
#   is the VERIFY exit code: a tampered artifact records a REJECT this run, and verify reports the chain as
#   DRIFTED (exit 3) — blocking the merge. A deleted / reordered / inserted / hand-edited PAST line BREAKS
#   the chain and verify LOCALIZES the first break (also exit 3).
#
# TRUST BOUNDARY (this gate will not let you overclaim)
#   A PASS proves ORDERING + CONTINUITY of the verifier's OWN observations + tamper-evidence of the record.
#   The `ts` on each entry is SELF-ASSERTED (the verifier's own wall clock), NOT a trusted timestamp — so the
#   journal NEVER claims "unaltered since date T" on its own; that claim needs a trust-root that signs/
#   timestamps the `ts` (STRATEGY.md P-3). See docs/INTEGRITY-JOURNAL.md.
#
# PERSIST THE JOURNAL BETWEEN RUNS
#   The continuous value comes from the SAME journal file GROWING across runs. Persist VH_JOURNAL between CI
#   runs (a cache, a committed file, or a stored build artifact) so the chain accumulates; a fresh journal
#   each run only ever proves a single observation. `append` creates the file on the first run.
#
# DEPENDENCIES
#   The full verifyhash package (from `npm i verifyhash` / `npx vh`, which brings in ethers as a runtime
#   dependency) plus a POSIX shell — NO ADDITIONAL dependencies, no hardhat (a devDep, never installed for
#   consumers), and no network (append/verify are pure-local file ops).
#   INDEPENDENCE NOTE: unlike the ZERO-DEPENDENCY standalone `verify-vh` bundle in verifier/ (which vendors its
#   own keccak and needs no ethers), the `vh journal` gate runs the PRODUCER package. Journal verification is
#   not YET available in the standalone independent verifier, so re-verifying a journal today requires the
#   producer stack. See docs/INTEGRITY-JOURNAL.md ("Independence scope").
#
# CONFIGURE VIA ENVIRONMENT (so this file is literal copy-paste; no in-file editing required):
#   VH_BIN       the `vh` command                          (default: vh — on PATH via npm; or a path)
#   VH_JOURNAL   path to the append-only journal file       (REQUIRED; created on first append)
#   VH_ARTIFACT  a *.vhevidence.json seal / signed container to record this run (optional; when unset the
#                gate ONLY re-verifies the standing chain without appending)
#   VH_DIR       dir holding the seal's referenced files     (optional; defaults to the artifact's own dir)
#   VH_TS        a self-asserted timestamp for the entry     (optional; defaults to the vh wall clock, ISO)
#
# EXIT CODES (passed straight through from `vh journal verify`, so the job status is meaningful):
#   0  PASS      — unbroken chain, every recorded observation ACCEPTED; allow the merge.
#   3  BROKEN/DRIFTED — the chain was tampered OR a recorded observation was REJECTED; BLOCK the merge.
#   2  USAGE     — misconfiguration (missing VH_JOURNAL / bad flag); never reported as "passed".
#   1  IO        — a file could not be read/written; never reported as "passed".
#
# Usage:
#   VH_JOURNAL=./integrity.jsonl VH_ARTIFACT=./dist/release.vhevidence.json ./journal.generic.sh
set -euo pipefail

VH_BIN="${VH_BIN:-vh}"

if [ -z "${VH_JOURNAL:-}" ]; then
  echo "journal CI gate: set VH_JOURNAL to the path of the append-only journal file." >&2
  exit 2
fi

# 1) APPEND this run's observation (the normal path). Skipped only when VH_ARTIFACT is unset (re-verify the
#    standing chain without recording a new entry). Recording a REJECT is a SUCCESSFUL append (exit 0) — the
#    drift surfaces at verify time below. A usage/IO failure of append (exit 2/1) is a real gate failure
#    (we could not even record), passed straight through.
if [ -n "${VH_ARTIFACT:-}" ]; then
  set -- journal append "$VH_ARTIFACT" --to "$VH_JOURNAL"
  if [ -n "${VH_DIR:-}" ]; then set -- "$@" --dir "$VH_DIR"; fi
  if [ -n "${VH_TS:-}" ]; then set -- "$@" --ts "$VH_TS"; fi

  set +e
  "$VH_BIN" "$@"
  append_code=$?
  set -e
  if [ "$append_code" -ne 0 ]; then
    echo "journal CI gate: append FAILED (exit $append_code) — could not record this run's observation." >&2
    exit "$append_code"
  fi
fi

# 2) VERIFY the whole standing chain. This is the gate's verdict — the SHARED 0/3 verify contract, passed
#    straight through so the CI job status is meaningful.
set +e
"$VH_BIN" journal verify "$VH_JOURNAL"
code=$?
set -e

if [ "$code" -ne 0 ]; then
  echo "journal CI gate: FAILED (exit $code) — the integrity journal is BROKEN or recorded a DRIFT; blocking the merge." >&2
fi
exit "$code"

#!/usr/bin/env python3
"""prove.py — the single, committed reproduce entrypoint for the einvoice
"machine-proven-coverage" claim.

Run ONE command and watch the whole claim rebuild itself from the vendored
official artifacts, end to end, with every headline number read LIVE from the
machine-recomputed committed source (never a string literal):

    PYTHONPATH=$HOME/.local/lib/python3.10/site-packages python3 prove.py

What it does, in order (exits non-zero if ANY step fails):

  1. runs ``differential.py`` over ALL SIX legs — for every one of our
     implemented rule / syntax-binding ids it asks the same yes/no question of
     the OFFICIAL vendored CEN / KoSIT Schematron (via Saxon) and of our engine,
     over the whole corpus, and counts DIVERGENCES (a false-positive or a miss).
     It asserts + echoes that the divergence count is 0. The two heavy legs
     (``sb`` ~30 s, ``sbcii`` ~90 s serial) are each run as several INDEPENDENT
     shards across CPU cores via the opt-in ``DIFF_SHARD=i/n`` hook in
     differential.py; a divergence is counted per (rule, invoice), so a
     by-invoice partition sums back to the exact whole-corpus total — every
     invoice is still graded once. This turns a ~3-minute serial run into well
     under a minute WITHOUT weakening the proof.
  2. runs ``conformance.py`` — the targeted invalid/valid fragment corpus — and
     asserts it reports 0 hard fails (0 false positives, every covered invalid
     vector detected with the correct rule id). It runs concurrently with the
     differential shards.
  3. recomputes the coverage headline LIVE and prints it in the canonical shape:
         N business rules / 0 divergences across all differential legs /
         U of Ut UBL + C of Ct CII syntax-binding asserts differential-proven
         per binding
     Every number is sourced from the same machine-recomputation the coverage /
     syntax-binding tests use — ``coverage_matrix.json['rule_count']`` for the
     rule count, ``einvoice.syntax_binding.accounting()`` for the per-binding
     totals, and ``einvoice.syntax_binding_eval.{implemented_ids,
     cii_implemented_ids}()`` for the differential-proven counts — so the printed
     headline can never silently drift from what the tests assert.

Standard library only. ``differential.py`` needs Saxon on ``PYTHONPATH``
(``$HOME/.local/lib/python3.10/site-packages``); this script prepends that path
to the child environment itself, so the single command above is enough.

Every child this script spawns runs with ``DIFF_NO_CACHE=1``: this is the
buyer-facing "reproduce this yourself" entrypoint, so the persistent
content-addressed proof cache differential.py keeps for ordinary gate runs
(``.official-cache/``) is unconditionally bypassed — a prove.py run is always a
fully LIVE Saxon re-proof, never a replay of memoized verdicts from a warm box.

Companion test: ``test_prove.py`` runs this script, asserts it exits 0 and
prints ``0 divergences``, and asserts the printed UBL / CII / rule numbers equal
a fresh independent recompute — proving this entrypoint reports live truth.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

COVERAGE_MATRIX = os.path.join(HERE, "coverage_matrix.json")
_LOCAL_SITE = os.path.expanduser("~/.local/lib/python3.10/site-packages")

# All six differential legs. The two heavy legs are sharded across cores; the
# four light legs (each a few seconds) run whole.
_LIGHT_LEGS = ("en", "xrechnung", "cii", "xrechnung-cii")
_HEAVY_LEGS = ("sb", "sbcii")
_NCPU = os.cpu_count() or 4
_SHARDS = max(2, min(4, _NCPU))  # shards per heavy leg


def _child_env(shard=None):
    """Environment for a differential/conformance subprocess: guarantee the
    Saxon site-packages dir is on PYTHONPATH so the single documented command
    works even if the caller forgot to export it; optionally set the opt-in
    ``DIFF_SHARD`` partition selector."""
    env = os.environ.copy()
    parts = [_LOCAL_SITE]
    if env.get("PYTHONPATH"):
        parts.append(env["PYTHONPATH"])
    env["PYTHONPATH"] = os.pathsep.join(parts)
    # The reproduce entrypoint must ALWAYS be a fully live Saxon re-proof:
    # unconditionally bypass differential.py's persistent proof cache
    # (.official-cache/), which only ordinary gate runs may use.
    env["DIFF_NO_CACHE"] = "1"
    if shard is not None:
        env["DIFF_SHARD"] = shard
    else:
        env.pop("DIFF_SHARD", None)
    return env


def _run(argv, env):
    proc = subprocess.run(
        argv, cwd=HERE, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    return proc.returncode, proc.stdout


def _diff_job(leg, shard):
    """Run one differential leg (optionally one shard) as a subprocess and
    return (leg, shard, returncode, divergence_count_or_None, output)."""
    rc, out = _run([sys.executable, os.path.join(HERE, "differential.py"), leg],
                   _child_env(shard))
    m = re.search(r"OVERALL DIVERGENCES ACROSS LEGS:\s*(\d+)", out)
    div = int(m.group(1)) if m else None
    return (leg, shard, rc, div, out)


def _conformance_job():
    rc, out = _run([sys.executable, os.path.join(HERE, "conformance.py")],
                   _child_env())
    m = re.search(r"HARD FAILS:\s*(\d+)", out)
    hard = int(m.group(1)) if m else None
    return (rc, hard, out)


def _recompute_headline_numbers():
    """Read every headline number LIVE from the machine-recomputed committed
    source — the SAME recomputation test_coverage_matrix.py / test_syntax_binding
    perform — so the printed headline cannot drift from what the tests assert."""
    from einvoice import syntax_binding as _sb  # noqa: E402
    from einvoice import syntax_binding_eval as _sbe  # noqa: E402

    with open(COVERAGE_MATRIX, encoding="utf-8") as fh:
        rule_count = json.load(fh)["rule_count"]

    acct = _sb.accounting(HERE)
    return {
        "rule_count": rule_count,
        "ubl_total": acct["ubl"]["total"],
        "cii_total": acct["cii"]["total"],
        "ubl_proven": len(_sbe.implemented_ids()),
        "cii_proven": len(_sbe.cii_implemented_ids()),
    }


def _headline(divergences, n):
    return (
        "%d business rules / %d divergences across all differential legs / "
        "%d of %d UBL + %d of %d CII syntax-binding asserts differential-proven "
        "per binding"
        % (n["rule_count"], divergences, n["ubl_proven"], n["ubl_total"],
           n["cii_proven"], n["cii_total"])
    )


def main(argv):
    print("=" * 78)
    print("verifyhash einvoice — reproduce the machine-proven-coverage claim")
    print("=" * 78)
    print("Running differential.py over ALL 6 legs (heavy legs sharded %dx "
          "across %d cores) + conformance.py, concurrently ...\n"
          % (_SHARDS, _NCPU), flush=True)

    # ---- build the job list: light legs whole, heavy legs sharded ---------
    diff_jobs = [(leg, None) for leg in _LIGHT_LEGS]
    for leg in _HEAVY_LEGS:
        for i in range(_SHARDS):
            diff_jobs.append((leg, "%d/%d" % (i, _SHARDS)))

    # ---- run differential shards + conformance concurrently ---------------
    # Subprocesses are the unit of work; threads only wait on them. conformance
    # is subprocess-startup bound (it spawns the CLI per fragment) and does not
    # saturate a core, so it gets its OWN executor; the CPU-bound Saxon
    # differential shards get a pool sized to the core count so they do not
    # oversubscribe against each other. The two overlap for the whole run.
    with ThreadPoolExecutor(max_workers=1) as conf_ex, \
            ThreadPoolExecutor(max_workers=max(1, _NCPU - 1)) as ex:
        conf_future = conf_ex.submit(_conformance_job)
        # heavy shards first so they get picked up early
        diff_futures = [ex.submit(_diff_job, leg, shard)
                        for (leg, shard) in reversed(diff_jobs)]
        diff_results = [f.result() for f in diff_futures]
        conf_rc, hard_fails, conf_out = conf_future.result()

    # ---- STEP 1: differential — sum divergences across every leg/shard -----
    print("#" * 78)
    print("# STEP 1/3 — differential (all 6 legs, %d parallel shards on the two "
          "heavy legs)" % _SHARDS)
    print("#" * 78)
    divergences = 0
    per_leg = {}
    failed = False
    for (leg, shard, rc, div, out) in diff_results:
        tag = leg if shard is None else "%s[%s]" % (leg, shard)
        if rc != 0 or div is None:
            failed = True
            print("  FAILED leg %-16s rc=%d (no divergence line)" % (tag, rc))
            sys.stdout.write(out[-2000:])
        else:
            per_leg[leg] = per_leg.get(leg, 0) + div
            print("  leg %-16s divergences=%d" % (tag, div))
        divergences += (div or 0)
    print("")
    for leg in _LIGHT_LEGS + _HEAVY_LEGS:
        print("  LEG total  %-16s divergences=%d" % (leg, per_leg.get(leg, 0)))
    print("\n  -> differential.py reported %d divergences across all legs.\n"
          % divergences, flush=True)
    if failed:
        print("FAILED: at least one differential leg/shard did not complete.")
        return 1
    if divergences != 0:
        print("FAILED: expected 0 divergences, got %d." % divergences)
        return 1

    # ---- STEP 2: conformance corpus; hard fails MUST be 0 -----------------
    print("#" * 78)
    print("# STEP 2/3 — conformance corpus (conformance.py)")
    print("#" * 78)
    if conf_rc != 0 or hard_fails is None:
        print("  FAILED: conformance.py exited %d / no HARD FAILS line." % conf_rc)
        sys.stdout.write(conf_out[-3000:])
        return 1
    print("  -> conformance.py reported %d hard fails.\n" % hard_fails,
          flush=True)
    if hard_fails != 0:
        print("FAILED: expected 0 conformance hard fails, got %d." % hard_fails)
        return 1

    # ---- STEP 3: recompute + print the headline LIVE ----------------------
    print("#" * 78)
    print("# STEP 3/3 — coverage headline (recomputed live, no literals)")
    print("#" * 78)
    n = _recompute_headline_numbers()
    headline = _headline(divergences, n)
    print("")
    print("HEADLINE: " + headline)
    print("")
    print("To additionally confirm the PUBLISHED numbers match this source in "
          "one fast step,")
    print("run `python3 verify_attestation.py` — it recomputes attestation.json "
          "and exits")
    print("non-zero on any drift (a rule count, a coverage number, a pass rate, "
          "or a corpus byte).")
    print("")
    print("What each number means (all read live this run):")
    print("  - %d business rules       = coverage_matrix.json['rule_count'], the"
          % n["rule_count"])
    print("                              EN 16931 + XRechnung/Peppol BR-* rules")
    print("                              our engine implements (asserted by")
    print("                              test_coverage_matrix.py).")
    print("  - %d divergences          = differential.py step 1 above: 0 places"
          % divergences)
    print("                              where our yes/no verdict departs from the")
    print("                              official Schematron over the whole corpus")
    print("                              (all 6 legs, every invoice graded once).")
    print("  - %d of %d UBL / %d of %d CII = syntax-binding asserts our restricted"
          % (n["ubl_proven"], n["ubl_total"], n["cii_proven"], n["cii_total"]))
    print("                              evaluator proves equivalent per binding")
    print("                              (differential.py LEG 5 `sb` / LEG 6")
    print("                              `sbcii`); totals from")
    print("                              syntax_binding.accounting(), proven counts")
    print("                              from syntax_binding_eval.implemented_ids()")
    print("                              / cii_implemented_ids() — the same")
    print("                              recompute test_syntax_binding.py asserts.")
    print("")
    print("PROVEN: %d divergences across all differential legs, 0 conformance "
          "hard fails." % divergences)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

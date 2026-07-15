#!/usr/bin/env python3
"""test_prove.py — prove.py must be a LIVE reproduce entrypoint, not a frozen
string. This gate runs prove.py end to end and asserts:

  (a) it exits 0 (both differential.py all-legs and conformance.py passed);
  (b) its output contains ``0 divergences`` and the full canonical headline
      (business-rule count + UBL/CII syntax-binding proven counts);
  (c) the UBL / CII / rule numbers it PRINTS equal a fresh, INDEPENDENT
      recompute here — from the same machine-recomputed committed source the
      coverage / syntax-binding tests use (coverage_matrix.json['rule_count'],
      syntax_binding.accounting(), syntax_binding_eval.{implemented_ids,
      cii_implemented_ids}()). So if prove.py ever hardcoded or drifted a number,
      this fails.

Standard library only. Runs prove.py once (which itself runs the full
differential + conformance, a few minutes) and checks that single transcript.

    PYTHONPATH=$HOME/.local/lib/python3.10/site-packages python3 test_prove.py
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

COVERAGE_MATRIX = os.path.join(HERE, "coverage_matrix.json")
_LOCAL_SITE = os.path.expanduser("~/.local/lib/python3.10/site-packages")

_FAILURES = []


def check(cond, msg):
    if not cond:
        _FAILURES.append(msg)


def _independent_recompute():
    """Recompute every headline number WITHOUT going through prove.py, from the
    same committed source the coverage/syntax-binding tests use."""
    from einvoice import syntax_binding as _sb
    from einvoice import syntax_binding_eval as _sbe

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


def _child_env():
    env = os.environ.copy()
    parts = [_LOCAL_SITE]
    if env.get("PYTHONPATH"):
        parts.append(env["PYTHONPATH"])
    env["PYTHONPATH"] = os.pathsep.join(parts)
    return env


def main():
    # ---- run prove.py once (full differential + conformance) --------------
    proc = subprocess.run(
        [sys.executable, os.path.join(HERE, "prove.py")],
        cwd=HERE,
        env=_child_env(),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    out = proc.stdout

    # (a) exit 0
    check(proc.returncode == 0,
          "prove.py exited %d (expected 0). tail:\n%s"
          % (proc.returncode, "\n".join(out.splitlines()[-25:])))

    # (b) prints '0 divergences' and the full headline
    check("0 divergences" in out,
          "prove.py output does not contain '0 divergences'")

    m = re.search(
        r"HEADLINE:\s*(\d+) business rules / (\d+) divergences across all "
        r"differential legs / (\d+) of (\d+) UBL \+ (\d+) of (\d+) CII "
        r"syntax-binding asserts differential-proven per binding",
        out)
    check(m is not None,
          "prove.py did not print the canonical HEADLINE line")

    if m is not None:
        printed = {
            "rule_count": int(m.group(1)),
            "divergences": int(m.group(2)),
            "ubl_proven": int(m.group(3)),
            "ubl_total": int(m.group(4)),
            "cii_proven": int(m.group(5)),
            "cii_total": int(m.group(6)),
        }
        # (b') the headline's divergence field is exactly 0
        check(printed["divergences"] == 0,
              "printed headline divergences = %d (expected 0)"
              % printed["divergences"])

        # (c) printed numbers == an INDEPENDENT fresh recompute
        expect = _independent_recompute()
        for key in ("rule_count", "ubl_total", "cii_total",
                    "ubl_proven", "cii_proven"):
            check(printed[key] == expect[key],
                  "prove.py printed %s=%d but independent recompute says %d "
                  "(entrypoint reports a stale/frozen number, not live truth)"
                  % (key, printed[key], expect[key]))

    if _FAILURES:
        sys.stderr.write("PROVE ENTRYPOINT TEST: FAIL (%d)\n" % len(_FAILURES))
        for f in _FAILURES:
            sys.stderr.write("  !! " + f + "\n")
        return 1
    print("PROVE ENTRYPOINT TEST: PASS — prove.py exits 0, prints '0 "
          "divergences', and its rule/UBL/CII numbers match a fresh independent "
          "recompute (live truth, not a frozen string).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""conformance.py -- differential harness: run BOTH verifiers on the SAME inputs.

Runs the reference JS verifier and the pure-Python port over an identical set of
inputs and asserts they return BYTE-IDENTICAL VERDICTS: the same ACCEPT/REJECT
decision AND the same process exit code (and, as a stronger check, the same
machine-readable verdict/reason from `--json`).

A DIVERGENCE (the two verifiers disagree with each other on the same input) is the
single most important outcome and is surfaced loudly. A case that agrees between
verifiers but does not match the case's EXPECTED verdict is a weaker failure
(EXPECTATION MISMATCH) and is also reported.

The harness is self-contained: it builds a fresh workspace, seals a genuine signed
packet with the producer CLI, then derives the four cases from it. Nothing outside
the py-verifier tree is written.

Cases:
  1. genuine packet + correct vendor        -> both ACCEPT, exit 0
  2. tampered file (one byte flipped)        -> both REJECT, exit 3
  3. correct packet + WRONG vendor address   -> both REJECT, exit 3
  4. a missing referenced file               -> both REJECT, exit 3

Exit code of the harness itself:
  0  every case AGREED between verifiers AND matched its expected verdict
  1  at least one DIVERGENCE or EXPECTATION MISMATCH
  2  harness setup failure (could not build fixtures)
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

# --------------------------------------------------------------------------
# Fixed paths / constants
# --------------------------------------------------------------------------

HERE = os.path.dirname(os.path.abspath(__file__))
PY_ROOT = os.path.dirname(HERE)  # .../scratchpad/py-verifier

JS_VERIFIER = "/home/loopdev/verifyhash/verifier/verify-vh.js"
VH_CLI = "/home/loopdev/verifyhash/cli/vh.js"
PY_VERIFIER = os.path.join(HERE, "verify_vh.py")

SELF_LICENSE = "/home/loopdev/.verifyhash-selflicense.json"
VENDOR_KEY = "/home/loopdev/.verifyhash-vendor-key.txt"

CORRECT_VENDOR = "0x7cb4d3DC6C52996B6386473Bfb32f898263412f7"
# A valid-format address that is NOT the signer.
WRONG_VENDOR = "0x1111111111111111111111111111111111111111"

WORKSPACE = os.path.join(PY_ROOT, "conformance-ws")

RESET = "\033[0m"
BOLD = "\033[1m"
RED = "\033[31m"
GREEN = "\033[32m"
YELLOW = "\033[33m"


def _c(text: str, color: str) -> str:
    if not sys.stdout.isatty():
        return text
    return f"{color}{text}{RESET}"


# --------------------------------------------------------------------------
# Fixture construction
# --------------------------------------------------------------------------

def build_fixtures() -> dict:
    """Build a fresh workspace and return the per-case run descriptors."""
    if os.path.exists(WORKSPACE):
        shutil.rmtree(WORKSPACE)
    os.makedirs(WORKSPACE)

    # 1) source directory that we will seal
    src = os.path.join(WORKSPACE, "src")
    os.makedirs(src)
    with open(os.path.join(src, "report.txt"), "wb") as f:
        f.write(b"hello from verifyhash conformance\nline two\n")
    with open(os.path.join(src, "data.json"), "wb") as f:
        f.write(b'{"k":"v","n":42}\n')

    # 2) seal it into a GENUINE signed packet via the producer CLI
    packet = os.path.join(WORKSPACE, "seal-genuine.json")
    proc = subprocess.run(
        ["node", VH_CLI, "evidence", "seal", src,
         "--sign",
         "--license", SELF_LICENSE,
         "--vendor", CORRECT_VENDOR,
         "--key-file", VENDOR_KEY,
         "--out", packet],
        capture_output=True, text=True,
    )
    if proc.returncode != 0 or not os.path.exists(packet):
        sys.stderr.write("FATAL: could not seal genuine packet\n")
        sys.stderr.write(proc.stdout + "\n" + proc.stderr + "\n")
        sys.exit(2)

    # 3) dir variants used by the cases
    # genuine + tampered + missing all reference report.txt / data.json under a --dir
    tampered = os.path.join(WORKSPACE, "files-tampered")
    shutil.copytree(src, tampered)
    # flip ONE byte in report.txt
    p = os.path.join(tampered, "report.txt")
    with open(p, "rb") as f:
        data = bytearray(f.read())
    data[0] ^= 0x01
    with open(p, "wb") as f:
        f.write(data)

    missing = os.path.join(WORKSPACE, "files-missing")
    shutil.copytree(src, missing)
    os.remove(os.path.join(missing, "data.json"))  # referenced but now absent

    # Case descriptors: (name, description, argv-after-verifier, expected_accept)
    return {
        "packet": packet,
        "cases": [
            {
                "name": "genuine+correct-vendor",
                "desc": "genuine packet + correct vendor",
                "args": [packet, "--vendor", CORRECT_VENDOR, "--dir", src],
                "expect_accept": True,
                "expect_exit": 0,
            },
            {
                "name": "tampered-file",
                "desc": "tampered file (one byte flipped)",
                "args": [packet, "--vendor", CORRECT_VENDOR, "--dir", tampered],
                "expect_accept": False,
                "expect_exit": 3,
            },
            {
                "name": "wrong-vendor",
                "desc": "correct packet + WRONG vendor address",
                "args": [packet, "--vendor", WRONG_VENDOR, "--dir", src],
                "expect_accept": False,
                "expect_exit": 3,
            },
            {
                "name": "missing-file",
                "desc": "a missing referenced file",
                "args": [packet, "--vendor", CORRECT_VENDOR, "--dir", missing],
                "expect_accept": False,
                "expect_exit": 3,
            },
        ],
    }


# --------------------------------------------------------------------------
# Running a single verifier
# --------------------------------------------------------------------------

def run_verifier(cmd_prefix: list, args: list) -> dict:
    """Run one verifier with --json; return {exit, verdict, reason, accepted, raw}."""
    proc = subprocess.run(
        cmd_prefix + args + ["--json"],
        capture_output=True, text=True,
    )
    exit_code = proc.returncode
    verdict = None
    reason = None
    accepted = None
    parsed_ok = False
    # Try to parse JSON from stdout (both emit a JSON object on stdout with --json).
    out = proc.stdout.strip()
    try:
        obj = json.loads(out)
        parsed_ok = True
        verdict = obj.get("verdict")
        reason = obj.get("reason")
        accepted = obj.get("accepted")
    except Exception:
        parsed_ok = False

    # Fall back to exit-code-derived ACCEPT/REJECT if JSON was unavailable
    # (e.g. an IO/usage error that prints no JSON object).
    if accepted is None:
        if exit_code == 0:
            accepted = True
        elif exit_code == 3:
            accepted = False
        # else leave None -> ERROR-class, will not equal an ACCEPT/REJECT

    return {
        "exit": exit_code,
        "verdict": verdict,
        "reason": reason,
        "accepted": accepted,
        "parsed_ok": parsed_ok,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }


def label(accepted, exit_code) -> str:
    if accepted is True:
        return f"ACCEPT/{exit_code}"
    if accepted is False:
        return f"REJECT/{exit_code}"
    return f"ERROR/{exit_code}"


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main() -> int:
    for path, name in ((JS_VERIFIER, "JS verifier"),
                       (PY_VERIFIER, "PY verifier"),
                       (VH_CLI, "vh CLI")):
        if not os.path.exists(path):
            sys.stderr.write(f"FATAL: {name} not found at {path}\n")
            return 2

    fx = build_fixtures()

    rows = []
    divergences = []
    expectation_misses = []

    for case in fx["cases"]:
        js = run_verifier(["node", JS_VERIFIER], case["args"])
        py = run_verifier(["python3", PY_VERIFIER], case["args"])

        # Primary agreement: same ACCEPT/REJECT decision AND same exit code.
        decision_agrees = (js["accepted"] == py["accepted"]) and (js["exit"] == py["exit"])
        # Stronger: same machine verdict + reason string too.
        verdict_agrees = (js["verdict"] == py["verdict"]) and (js["reason"] == py["reason"])
        agree = decision_agrees and verdict_agrees

        js_label = label(js["accepted"], js["exit"])
        py_label = label(py["accepted"], py["exit"])

        expected_label = label(case["expect_accept"], case["expect_exit"])
        matches_expected = (
            js["accepted"] == case["expect_accept"]
            and js["exit"] == case["expect_exit"]
        )

        if not decision_agrees:
            status = "DIVERGENCE"
            divergences.append((case, js, py, "decision"))
        elif not verdict_agrees:
            # Same accept/reject + exit, but the JSON verdict/reason string differs.
            status = "DIVERGENCE(reason)"
            divergences.append((case, js, py, "reason"))
        elif not matches_expected:
            status = "EXPECT-MISS"
            expectation_misses.append((case, js, py))
        else:
            status = "PASS"

        rows.append({
            "case": case,
            "js": js,
            "py": py,
            "status": status,
            "expected_label": expected_label,
            "js_label": js_label,
            "py_label": py_label,
        })

    # ---- print matrix ----
    print()
    print(_c("=" * 88, BOLD))
    print(_c(" verifyhash CONFORMANCE MATRIX — JS verify-vh.js  vs  Python verify_vh.py", BOLD))
    print(_c("=" * 88, BOLD))
    print(f" genuine packet: {fx['packet']}")
    print(f" JS  : node {JS_VERIFIER}")
    print(f" PY  : python3 {PY_VERIFIER}")
    print(_c("-" * 88, BOLD))
    hdr = f" {'case':<26} {'expected':<11} {'JS':<11} {'PY':<11} {'reason':<20} result"
    print(_c(hdr, BOLD))
    print(_c("-" * 88, BOLD))

    for r in rows:
        c = r["case"]
        reason = r["js"]["reason"] if r["js"]["reason"] == r["py"]["reason"] else \
            f"{r['js']['reason']}!={r['py']['reason']}"
        reason = "" if reason is None else str(reason)
        if r["status"] == "PASS":
            res = _c("PASS", GREEN)
        elif r["status"].startswith("DIVERGENCE"):
            res = _c(">>> " + r["status"] + " <<<", RED)
        else:
            res = _c(r["status"], YELLOW)
        line = (f" {c['name']:<26} {r['expected_label']:<11} "
                f"{r['js_label']:<11} {r['py_label']:<11} {reason:<20} ")
        print(line + res)

    print(_c("-" * 88, BOLD))

    # ---- loud divergence report ----
    if divergences:
        print()
        print(_c("!" * 88, RED))
        print(_c(f"!!!  {len(divergences)} DIVERGENCE(S): THE TWO VERIFIERS DISAGREE  !!!", RED + BOLD))
        print(_c("!" * 88, RED))
        for case, js, py, kind in divergences:
            print()
            print(_c(f"  CASE: {case['name']}  ({case['desc']})", RED + BOLD))
            print(f"    args      : {' '.join(case['args'])}")
            print(f"    kind      : {kind} mismatch")
            print(_c(f"    JS  -> exit {js['exit']}  accepted={js['accepted']}  "
                     f"verdict={js['verdict']}  reason={js['reason']}", RED))
            print(_c(f"    PY  -> exit {py['exit']}  accepted={py['accepted']}  "
                     f"verdict={py['verdict']}  reason={py['reason']}", RED))
            print("    --- JS stdout (head) ---")
            print("      " + "\n      ".join(js["stdout"].strip().splitlines()[:6]))
            print("    --- PY stdout (head) ---")
            print("      " + "\n      ".join(py["stdout"].strip().splitlines()[:6]))
        print()
        print(_c("!" * 88, RED))

    if expectation_misses and not divergences:
        print()
        print(_c(f"NOTE: {len(expectation_misses)} case(s) AGREED between verifiers but did NOT "
                 f"match the expected verdict:", YELLOW))
        for case, js, py in expectation_misses:
            print(_c(f"  - {case['name']}: expected {label(case['expect_accept'], case['expect_exit'])}, "
                     f"both returned {label(js['accepted'], js['exit'])}", YELLOW))

    # ---- summary ----
    n = len(rows)
    n_pass = sum(1 for r in rows if r["status"] == "PASS")
    print()
    if divergences:
        print(_c(f"RESULT: FAIL — {len(divergences)} DIVERGENCE(S) across {n} cases "
                 f"({n_pass}/{n} fully passed).", RED + BOLD))
        return 1
    if expectation_misses:
        print(_c(f"RESULT: FAIL — verifiers AGREE on all {n} cases, but "
                 f"{len(expectation_misses)} did not match the expected verdict.", YELLOW + BOLD))
        return 1
    print(_c(f"RESULT: PASS — all {n} cases AGREE between verifiers AND match the expected "
             f"verdict (byte-identical ACCEPT/REJECT + exit code).", GREEN + BOLD))
    return 0


if __name__ == "__main__":
    sys.exit(main())

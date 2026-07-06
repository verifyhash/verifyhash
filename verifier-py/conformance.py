#!/usr/bin/env python3
"""conformance.py -- differential harness: run BOTH verifiers on the SAME inputs (T-76.1).

Runs the reference JS verifier (verifier/verify-vh.js) and the pure-Python port
(verifier-py/verify_vh.py) over an identical set of inputs and asserts they return
BYTE-IDENTICAL VERDICTS: the same ACCEPT/REJECT decision AND the same process exit
code (and, as a stronger check, the same machine-readable verdict/reason from
`--json`).

A DIVERGENCE (the two verifiers disagree with each other on the same input) is the
single most important outcome and is surfaced loudly. A case that agrees between
verifiers but does not match the case's EXPECTED verdict is a weaker failure
(EXPECTATION MISMATCH) and is also reported.

The harness is fully self-contained and REPO-RELATIVE: every path is resolved from
this file's own location (__file__), so it runs from ANY working directory. It
builds a fresh workspace in an OS temp dir (removed on exit), generates an
EPHEMERAL signing key in-memory via the repo's own ethers `Wallet.createRandom()`
(NEVER a real key, NEVER an operator license, NEVER persisted to disk -- the key
travels to child processes ONLY through an environment variable), mints an
ephemeral test license with that key, seals a genuine signed packet with the
shipped producer CLI (`node cli/vh.js evidence seal ... --key-env ...`, gate
re-pinned to the ephemeral identity via the documented VH_CANONICAL_VENDOR
self-hosting hook), then derives the four cases from it.

Cases:
  1. genuine packet + correct vendor         -> both ACCEPT, exit 0
  2. tampered file (one byte flipped)        -> both REJECT, exit 3
  3. correct packet + WRONG vendor address   -> both REJECT, exit 3
  4. a missing referenced file               -> both REJECT, exit 3

Exit code of the harness itself:
  0  every case AGREED between verifiers AND matched its expected verdict
  1  at least one DIVERGENCE or EXPECTATION MISMATCH
  2  harness setup failure (could not build fixtures)

Offline (nothing leaves the machine; the only child processes are local node /
python3 runs). Python stdlib only -- no new dependency in either language.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

# --------------------------------------------------------------------------
# Repo-relative paths / constants (NO absolute machine-specific paths).
# --------------------------------------------------------------------------

HERE = os.path.dirname(os.path.abspath(__file__))   # .../verifier-py
REPO = os.path.dirname(HERE)                        # the repo root

JS_VERIFIER = os.path.join(REPO, "verifier", "verify-vh.js")
VH_CLI = os.path.join(REPO, "cli", "vh.js")
PY_VERIFIER = os.path.join(HERE, "verify_vh.py")

# The env var the EPHEMERAL private key travels through (never argv, never disk).
KEY_ENV = "VH_CONFORMANCE_KEY"

# A valid-format address that is NOT the ephemeral signer (all-ones vanity).
WRONG_VENDOR = "0x1111111111111111111111111111111111111111"

# Any plan carrying the `evidence_signed` entitlement unlocks `--sign` for <= 25 files.
LICENSE_PLAN = "evidence-signed-monthly"

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
# Ephemeral key (test-only, in-memory, never persisted)
# --------------------------------------------------------------------------

def generate_ephemeral_key() -> tuple:
    """Mint a fresh throwaway keypair via the repo's own ethers Wallet.createRandom().

    Returns (private_key_hex, address). The key exists only in this process's
    memory and the env of the two producer child processes -- it is NEVER written
    to disk and is worthless the moment this harness exits.
    """
    script = (
        "const{Wallet}=require('ethers');"
        "const w=Wallet.createRandom();"
        "process.stdout.write(w.privateKey+' '+w.address);"
    )
    proc = subprocess.run(
        ["node", "-e", script],
        capture_output=True, text=True, cwd=REPO,
    )
    if proc.returncode != 0:
        sys.stderr.write("FATAL: could not generate an ephemeral key via node/ethers\n")
        sys.stderr.write(proc.stdout + "\n" + proc.stderr + "\n")
        sys.exit(2)
    parts = proc.stdout.strip().split(" ")
    if len(parts) != 2 or not re.match(r"^0x[0-9a-fA-F]{64}$", parts[0]) \
            or not re.match(r"^0x[0-9a-fA-F]{40}$", parts[1]):
        sys.stderr.write(f"FATAL: unexpected keygen output: {proc.stdout!r}\n")
        sys.exit(2)
    return parts[0], parts[1]


# --------------------------------------------------------------------------
# Fixture construction
# --------------------------------------------------------------------------

def build_fixtures(workspace: str) -> dict:
    """Build the fixtures in `workspace` and return the per-case run descriptors."""
    priv_key, vendor = generate_ephemeral_key()
    if vendor.lower() == WRONG_VENDOR:
        sys.stderr.write("FATAL: ephemeral address collided with the WRONG_VENDOR constant\n")
        sys.exit(2)

    # The key reaches the producer CLI ONLY via --key-env (never argv, never a file).
    # VH_CANONICAL_VENDOR is the documented self-hosting hook that re-pins the paid
    # gate to the ephemeral identity for this run (cli/core/vendor-identity.js).
    child_env = dict(os.environ)
    child_env[KEY_ENV] = priv_key
    child_env["VH_CANONICAL_VENDOR"] = vendor

    # 1) source directory that we will seal
    src = os.path.join(workspace, "src")
    os.makedirs(src)
    with open(os.path.join(src, "report.txt"), "wb") as f:
        f.write(b"hello from verifyhash conformance\nline two\n")
    with open(os.path.join(src, "data.json"), "wb") as f:
        f.write(b'{"k":"v","n":42}\n')

    # 2) mint an EPHEMERAL test license with the ephemeral key (self-issued, valid
    #    only against the re-pinned ephemeral identity -- worthless anywhere else).
    license_path = os.path.join(workspace, "conformance.vhlicense.json")
    proc = subprocess.run(
        ["node", VH_CLI, "evidence", "license", "fulfill",
         "--plan", LICENSE_PLAN,
         "--customer", "conformance-harness",
         "--key-env", KEY_ENV,
         "--out", license_path],
        capture_output=True, text=True, cwd=REPO, env=child_env,
    )
    if proc.returncode != 0 or not os.path.exists(license_path):
        sys.stderr.write("FATAL: could not mint the ephemeral test license\n")
        sys.stderr.write(proc.stdout + "\n" + proc.stderr + "\n")
        sys.exit(2)

    # 3) seal it into a GENUINE signed packet via the shipped producer CLI
    packet = os.path.join(workspace, "seal-genuine.json")
    proc = subprocess.run(
        ["node", VH_CLI, "evidence", "seal", src,
         "--sign",
         "--key-env", KEY_ENV,
         "--license", license_path,
         "--vendor", vendor,
         "--out", packet],
        capture_output=True, text=True, cwd=REPO, env=child_env,
    )
    if proc.returncode != 0 or not os.path.exists(packet):
        sys.stderr.write("FATAL: could not seal genuine packet\n")
        sys.stderr.write(proc.stdout + "\n" + proc.stderr + "\n")
        sys.exit(2)

    # 4) dir variants used by the cases
    tampered = os.path.join(workspace, "files-tampered")
    shutil.copytree(src, tampered)
    # flip ONE byte in report.txt
    p = os.path.join(tampered, "report.txt")
    with open(p, "rb") as f:
        data = bytearray(f.read())
    data[0] ^= 0x01
    with open(p, "wb") as f:
        f.write(data)

    missing = os.path.join(workspace, "files-missing")
    shutil.copytree(src, missing)
    os.remove(os.path.join(missing, "data.json"))  # referenced but now absent

    # Case descriptors: (name, description, argv-after-verifier, expected_accept)
    return {
        "packet": packet,
        "vendor": vendor,
        "cases": [
            {
                "name": "genuine+correct-vendor",
                "desc": "genuine packet + correct vendor",
                "args": [packet, "--vendor", vendor, "--dir", src],
                "expect_accept": True,
                "expect_exit": 0,
            },
            {
                "name": "tampered-file",
                "desc": "tampered file (one byte flipped)",
                "args": [packet, "--vendor", vendor, "--dir", tampered],
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
                "args": [packet, "--vendor", vendor, "--dir", missing],
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
        capture_output=True, text=True, cwd=REPO,
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
    for path_, name in ((JS_VERIFIER, "JS verifier"),
                        (PY_VERIFIER, "PY verifier"),
                        (VH_CLI, "vh CLI")):
        if not os.path.exists(path_):
            sys.stderr.write(f"FATAL: {name} not found at {path_}\n")
            return 2

    workspace = tempfile.mkdtemp(prefix="vh-py-conformance-")
    try:
        return run_matrix(workspace)
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


def run_matrix(workspace: str) -> int:
    fx = build_fixtures(workspace)

    rows = []
    divergences = []
    expectation_misses = []

    for case in fx["cases"]:
        js = run_verifier(["node", JS_VERIFIER], case["args"])
        py = run_verifier([sys.executable or "python3", PY_VERIFIER], case["args"])

        # Primary agreement: same ACCEPT/REJECT decision AND same exit code.
        decision_agrees = (js["accepted"] == py["accepted"]) and (js["exit"] == py["exit"])
        # Stronger: same machine verdict + reason string too.
        verdict_agrees = (js["verdict"] == py["verdict"]) and (js["reason"] == py["reason"])

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
    print(f" ephemeral vendor: {fx['vendor']}  (test-only key, never persisted)")
    print(f" JS  : node {os.path.relpath(JS_VERIFIER, REPO)}")
    print(f" PY  : python3 {os.path.relpath(PY_VERIFIER, REPO)}")
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

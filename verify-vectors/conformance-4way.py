#!/usr/bin/env python3
"""
4-way conformance harness for the vh evidence-seal verifier.

Runs ALL FOUR independent verifier implementations (JS, PY, GO, RUST) on
EVERY case in the frozen conformance vectors and asserts that all four
produce a BYTE-IDENTICAL verdict + exit code as one another (and reports
each against the vector's expected verdict/exit).

PASS condition: all four impls AGREE WITH EACH OTHER on every case.
The `extra-file` case is a KNOWN, DOCUMENTED shared spec gap: in --dir
mode every impl accepts an unsealed extra file (strict mode is a separate
backlog task). So on that case all four are expected to agree with each
other while differing from the vector's expected verdict; that is reported
as the known-gap, NOT as an inter-impl divergence.

Exit 0 iff all four impls agree with each other on every case.
"""
import json
import os
import subprocess
import sys

SCRATCH = "/tmp/claude-1000/-home-loopdev-verifyhash/3dab33db-6671-4a1f-af33-e6fa21050363/scratchpad"
VECTORS_DIR = os.path.join(SCRATCH, "go-verifier", "vectors")
VECTORS_JSON = os.path.join(VECTORS_DIR, "vectors.json")

JS_BIN = "/home/loopdev/verifyhash/verifier/verify-vh.js"
PY_BIN = os.path.join(SCRATCH, "py-verifier", "verifier-py", "verify_vh.py")
GO_BIN = os.path.join(SCRATCH, "go-verifier", "verifier-go", "verify-vh")
RUST_BIN = os.path.join(SCRATCH, "rust-verifier", "verifier-rs",
                        "target", "release", "verify-vh")

KNOWN_GAP_CASE = "extra-file"

IMPLS = ["JS", "PY", "GO", "RUST"]


def cmd_for(impl, packet, vendor, files_dir):
    if impl == "JS":
        return ["node", JS_BIN, packet, "--vendor", vendor, "--dir", files_dir, "--json"]
    if impl == "PY":
        return ["python3", PY_BIN, packet, "--vendor", vendor, "--dir", files_dir, "--json"]
    if impl == "GO":
        return [GO_BIN, packet, "--vendor", vendor, "--dir", files_dir, "--json"]
    if impl == "RUST":
        return [RUST_BIN, packet, "--vendor", vendor, "--dir", files_dir, "--json"]
    raise ValueError(impl)


def run_impl(impl, packet, vendor, files_dir):
    """Return (verdict, accepted, exit_code). verdict/accepted may be None on parse failure."""
    try:
        p = subprocess.run(
            cmd_for(impl, packet, vendor, files_dir),
            cwd=VECTORS_DIR,
            capture_output=True,
            text=True,
        )
    except Exception as e:  # pragma: no cover
        return ("<exec-error:%s>" % e, None, -1)
    exit_code = p.returncode
    verdict = None
    accepted = None
    try:
        d = json.loads(p.stdout)
        verdict = d.get("verdict")
        accepted = d.get("accepted")
    except Exception:
        verdict = "<no-json>"
    return (verdict, accepted, exit_code)


def build_binaries_if_missing():
    # GO
    if not os.path.exists(GO_BIN):
        goroot = os.path.join(SCRATCH, "go-toolchain", "go")
        env = dict(os.environ)
        env["GOROOT"] = goroot
        env["PATH"] = os.path.join(goroot, "bin") + os.pathsep + env.get("PATH", "")
        srcdir = os.path.join(SCRATCH, "go-verifier", "verifier-go")
        print("[build] GO binary missing -> building...", file=sys.stderr)
        subprocess.run(
            [os.path.join(goroot, "bin", "go"), "build", "-o", "verify-vh", "."],
            cwd=srcdir, env=env, check=True,
        )
    # RUST
    if not os.path.exists(RUST_BIN):
        env = dict(os.environ)
        env["RUSTUP_HOME"] = os.path.join(SCRATCH, "rustup")
        env["CARGO_HOME"] = os.path.join(SCRATCH, "cargo")
        env["CARGO_NET_OFFLINE"] = "true"
        env["PATH"] = os.path.join(SCRATCH, "cargo", "bin") + os.pathsep + env.get("PATH", "")
        srcdir = os.path.join(SCRATCH, "rust-verifier", "verifier-rs")
        print("[build] RUST binary missing -> building...", file=sys.stderr)
        subprocess.run(
            ["cargo", "build", "--release", "--offline"],
            cwd=srcdir, env=env, check=True,
        )


def main():
    build_binaries_if_missing()

    with open(VECTORS_JSON) as f:
        vectors = json.load(f)
    cases = vectors["cases"]

    rows = []
    inter_impl_divergences = []  # cases where the four impls disagree with EACH OTHER
    known_gap_rows = []

    for c in cases:
        name = c["name"]
        packet = c["packetRelPath"]
        files_dir = c["filesDirRelPath"]
        vendor = c["vendor"]
        exp_verdict = c["expectedVerdict"]
        exp_exit = c["expectedExit"]

        results = {impl: run_impl(impl, packet, vendor, files_dir) for impl in IMPLS}

        # Compare the four impls to EACH OTHER on (verdict, exit).
        signatures = {(r[0], r[2]) for r in results.values()}
        impls_agree = len(signatures) == 1

        # Do the (agreed) impls match the vector's expected?
        agreed_sig = next(iter(signatures)) if impls_agree else None
        matches_expected = impls_agree and agreed_sig == (
            _expected_verdict_token(exp_verdict), exp_exit)

        rows.append({
            "name": name,
            "results": results,
            "exp_verdict": exp_verdict,
            "exp_exit": exp_exit,
            "impls_agree": impls_agree,
            "matches_expected": matches_expected,
        })

        if not impls_agree:
            inter_impl_divergences.append(name)
        elif not matches_expected:
            # Impls agree with each other but differ from the vector expected.
            if name == KNOWN_GAP_CASE:
                known_gap_rows.append(name)
            else:
                # An agreed disagreement with the spec on a NON-known-gap case
                # is itself a conformance problem worth flagging loudly.
                inter_impl_divergences.append(name + " (all-agree BUT differ from spec, NOT the known gap)")

    print_matrix(rows)

    print()
    ok = len(inter_impl_divergences) == 0
    if not ok:
        print("=" * 72)
        print("!!!!!!!!!!!!!!!!!!!!!!  D I V E R G E N C E  !!!!!!!!!!!!!!!!!!!!!!")
        print("=" * 72)
        for name in inter_impl_divergences:
            row = next((r for r in rows if r["name"] == name.split(" ")[0]), None)
            print("  CASE '%s': the four verifiers DISAGREE." % name)
            if row:
                for impl in IMPLS:
                    v, a, e = row["results"][impl]
                    print("      %-4s -> verdict=%s accepted=%s exit=%s" % (impl, v, a, e))
        print("=" * 72)
    else:
        print("=" * 72)
        print("  4-WAY AGREEMENT: JS == PY == GO == RUST on every case.")
        print("=" * 72)

    if known_gap_rows:
        print()
        print("KNOWN SHARED SPEC GAP (not an inter-impl divergence):")
        for name in known_gap_rows:
            row = next(r for r in rows if r["name"] == name)
            sig = next(iter({(r[0], r[2]) for r in row["results"].values()}))
            print("  CASE '%s': all four AGREE (verdict=%s exit=%s) but the vector"
                  % (name, sig[0], sig[1]))
            print("      expects verdict=%s exit=%s. In --dir mode every impl accepts"
                  % (row["exp_verdict"], row["exp_exit"]))
            print("      an unsealed extra file; strict mode is a separate backlog task.")

    print()
    if ok:
        print("VERDICT: PASS — all four implementations are byte-identical in "
              "verdict+exit on every case (the extra-file case is the documented "
              "shared gap, not a divergence).")
        sys.exit(0)
    else:
        print("VERDICT: FAIL — inter-implementation divergence detected (see banner).")
        sys.exit(1)


def _expected_verdict_token(exp_verdict):
    # Vectors use ACCEPT/REJECT; impls emit OK / REJECTED. Normalize for the
    # matches-expected check only (the inter-impl comparison uses raw impl output).
    return {"ACCEPT": "OK", "REJECT": "REJECTED"}.get(exp_verdict, exp_verdict)


def print_matrix(rows):
    print("=" * 96)
    print("4-WAY CONFORMANCE MATRIX  (verdict / exit)   impls compared byte-for-byte to each other")
    print("=" * 96)
    header = "%-16s | %-13s | %-13s | %-13s | %-13s | %-14s" % (
        "case", "JS", "PY", "GO", "RUST", "expected")
    print(header)
    print("-" * 96)
    for r in rows:
        cells = []
        for impl in IMPLS:
            v, a, e = r["results"][impl]
            cells.append("%s/%s" % (v, e))
        exp = "%s/%s" % (r["exp_verdict"], r["exp_exit"])
        flag = ""
        if not r["impls_agree"]:
            flag = "  <== IMPLS DISAGREE"
        elif not r["matches_expected"]:
            flag = "  <== known-gap" if r["name"] == KNOWN_GAP_CASE else "  <== agree-but-off-spec"
        print("%-16s | %-13s | %-13s | %-13s | %-13s | %-14s%s" % (
            r["name"], cells[0], cells[1], cells[2], cells[3], exp, flag))
    print("=" * 96)


if __name__ == "__main__":
    main()

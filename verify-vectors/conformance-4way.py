#!/usr/bin/env python3
"""
4-way conformance harness for the vh evidence-seal verifier (T-77.1).

Runs the up-to-four independent verifier implementations that live in THIS
repo — JS (verifier/verify-vh.js), Python (verifier-py/verify_vh.py),
Go (verifier-go/), Rust (verifier-rs/) — on EVERY case in the frozen
conformance vectors (vectors.json), in BOTH modes:

  * default --dir mode   — the seal's honest named-file-set semantics;
  * --exact-dir mode     — the fail-closed whole-directory gate (T-75.5).

and asserts that all PRESENT implementations produce a BYTE-IDENTICAL
verdict + exit code as one another, and that the agreed answer matches the
vector's expected verdict/exit:

  * in --exact-dir mode, EVERY case must match the vector expected — this is
    where the `extra-file` case goes GREEN (T-75.5 landed; all impls carry
    the mode);
  * in default mode, every case must match the vector expected EXCEPT
    `extra-file`, whose default-mode answer is ACCEPT/0 BY DESIGN (a seal
    binds a NAMED FILE SET, not a directory boundary — the documented
    boundary that --exact-dir exists to close).

PATHS are repo-relative (the repo root is resolved from __file__), so the
harness runs from any cwd. The Go and Rust binaries are built HERMETICALLY
OFFLINE from the landed sources (GOPROXY=off / cargo --offline); toolchains
are discovered via env or PATH:

  * Go:    $VH_GO_BIN, else $GOROOT/bin/go, else `go` on PATH   (>= 1.22)
  * Rust:  $VH_CARGO_BIN, else $CARGO_HOME/bin/cargo, else `cargo` on PATH;
           falling back to $VH_RUSTC_BIN / `rustc` on PATH       (>= 1.56)
  * JS:    $VH_NODE_BIN, else `node` on PATH

A MISSING toolchain SKIPS that leg with a visible notice — it never fails
the run. A real DIVERGENCE (two present implementations disagree) fails
LOUDLY, naming the case. Exit 0 iff every present implementation agrees
with every other AND with the vector expected (per the mode rules above).
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VECTORS_DIR = os.path.join(REPO_ROOT, "verify-vectors")
VECTORS_JSON = os.path.join(VECTORS_DIR, "vectors.json")

JS_VERIFIER = os.path.join(REPO_ROOT, "verifier", "verify-vh.js")
PY_VERIFIER = os.path.join(REPO_ROOT, "verifier-py", "verify_vh.py")
GO_SRC_DIR = os.path.join(REPO_ROOT, "verifier-go")
RS_SRC_DIR = os.path.join(REPO_ROOT, "verifier-rs")

# The cases whose DEFAULT-mode answer intentionally differs from the vector
# expected: a seal binds a NAMED FILE SET, so default --dir ACCEPTs an unsealed
# extra. --exact-dir (T-75.5) closes that boundary and must REJECT it.
#   * extra-file          — an injected plain file the seal never named;
#   * symlinked-artifact  — a symlink alias to the artifact packet, inside the
#                           scanned dir; --exact-dir must flag it UNEXPECTED via a
#                           LEXICAL (never symlink-resolving) self-exemption — the
#                           T-77.1 four-way parity lock.
BOUNDARY_CASES = frozenset(("extra-file", "symlinked-artifact"))
DEFAULT_MODE_BOUNDARY_SIG = ("OK", 0)

MODES = ("default", "exact-dir")


def log(msg):
    print(msg)


def notice(msg):
    # Visible skip/setup notices, kept apart from the result matrix.
    print("[conformance-4way] %s" % msg)


# ---------------------------------------------------------------------------
# Toolchain discovery (env first, then PATH) + hermetic offline builds.
# ---------------------------------------------------------------------------

def _probe_version(cmd, extra_env=None):
    """Run `cmd` and return its stdout on success, None on any failure."""
    env = dict(os.environ)
    if extra_env:
        env.update(extra_env)
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=60)
    except Exception:
        return None
    if p.returncode != 0:
        return None
    return (p.stdout or "") + (p.stderr or "")


def _parse_semverish(text):
    """Extract the first x.y[.z] number in text as an (x, y) tuple, or None."""
    import re
    m = re.search(r"(\d+)\.(\d+)(?:\.\d+)?", text or "")
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2)))


def build_root():
    override = os.environ.get("VH_CONFORMANCE_BUILD_DIR")
    if override:
        return override
    tag = hashlib.sha256(os.path.realpath(REPO_ROOT).encode("utf-8")).hexdigest()[:12]
    return os.path.join(tempfile.gettempdir(), "vh-conformance-" + tag)


def _newest_mtime(paths):
    newest = 0.0
    for p in paths:
        try:
            newest = max(newest, os.path.getmtime(p))
        except OSError:
            pass
    return newest


def _is_fresh(binary, sources):
    try:
        return os.path.getmtime(binary) >= _newest_mtime(sources)
    except OSError:
        return False


def find_node():
    cand = os.environ.get("VH_NODE_BIN") or shutil.which("node")
    if not cand or _probe_version([cand, "--version"]) is None:
        return None
    return cand


def find_go():
    candidates = []
    if os.environ.get("VH_GO_BIN"):
        candidates.append(os.environ["VH_GO_BIN"])
    if os.environ.get("GOROOT"):
        candidates.append(os.path.join(os.environ["GOROOT"], "bin", "go"))
    which = shutil.which("go")
    if which:
        candidates.append(which)
    for cand in candidates:
        out = _probe_version([cand, "version"])
        if out is None:
            continue
        ver = _parse_semverish(out)
        if ver is None or ver < (1, 22):
            notice("SKIP GO: toolchain at %s is older than go1.22 (go.mod pin) — leg skipped" % cand)
            return None
        return cand
    return None


def find_rust():
    """Return ('cargo', bin) or ('rustc', bin) or None."""
    cargo_candidates = []
    if os.environ.get("VH_CARGO_BIN"):
        cargo_candidates.append(os.environ["VH_CARGO_BIN"])
    if os.environ.get("CARGO_HOME"):
        cargo_candidates.append(os.path.join(os.environ["CARGO_HOME"], "bin", "cargo"))
    which = shutil.which("cargo")
    if which:
        cargo_candidates.append(which)
    for cand in cargo_candidates:
        out = _probe_version([cand, "--version"])
        if out is None:
            continue
        ver = _parse_semverish(out)
        if ver is None or ver < (1, 56):
            notice("SKIP RUST: cargo at %s is older than 1.56 (edition 2021) — leg skipped" % cand)
            return None
        return ("cargo", cand)
    rustc_candidates = []
    if os.environ.get("VH_RUSTC_BIN"):
        rustc_candidates.append(os.environ["VH_RUSTC_BIN"])
    which = shutil.which("rustc")
    if which:
        rustc_candidates.append(which)
    for cand in rustc_candidates:
        out = _probe_version([cand, "--version"])
        if out is None:
            continue
        ver = _parse_semverish(out)
        if ver is None or ver < (1, 56):
            notice("SKIP RUST: rustc at %s is older than 1.56 (edition 2021) — leg skipped" % cand)
            return None
        return ("rustc", cand)
    return None


def build_go(go_bin):
    """Hermetic OFFLINE build of verifier-go (zero external modules)."""
    out_dir = os.path.join(build_root(), "go")
    os.makedirs(out_dir, exist_ok=True)
    binary = os.path.join(out_dir, "verify-vh")
    sources = [os.path.join(GO_SRC_DIR, f) for f in os.listdir(GO_SRC_DIR)
               if f.endswith(".go") or f == "go.mod"]
    if _is_fresh(binary, sources):
        return binary
    env = dict(os.environ)
    env.update({
        "GOFLAGS": "-mod=readonly",
        "GOPROXY": "off",           # hermetic: no module downloads (none needed)
        "GOSUMDB": "off",
        "GOTOOLCHAIN": "local",     # hermetic: never auto-download a toolchain
        "CGO_ENABLED": "0",
        "GOCACHE": os.path.join(out_dir, "gocache"),
        "GOMODCACHE": os.path.join(out_dir, "gomodcache"),
    })
    notice("building GO verifier (offline) -> %s" % binary)
    p = subprocess.run([go_bin, "build", "-o", binary, "."],
                       cwd=GO_SRC_DIR, env=env, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError("go build FAILED (toolchain present, landed sources did not build):\n"
                           + p.stdout + p.stderr)
    return binary


def build_rust(kind, tool_bin):
    """Hermetic OFFLINE build of verifier-rs (zero external crates)."""
    out_dir = os.path.join(build_root(), "rust")
    os.makedirs(out_dir, exist_ok=True)
    src_dir = os.path.join(RS_SRC_DIR, "src")
    sources = [os.path.join(src_dir, f) for f in os.listdir(src_dir)]
    sources += [os.path.join(RS_SRC_DIR, "Cargo.toml"), os.path.join(RS_SRC_DIR, "Cargo.lock")]
    if kind == "cargo":
        binary = os.path.join(out_dir, "target", "release", "verify-vh")
        if _is_fresh(binary, sources):
            return binary
        env = dict(os.environ)
        env["CARGO_NET_OFFLINE"] = "true"
        notice("building RUST verifier with cargo (offline) -> %s" % binary)
        p = subprocess.run([tool_bin, "build", "--release", "--offline",
                            "--target-dir", os.path.join(out_dir, "target")],
                           cwd=RS_SRC_DIR, env=env, capture_output=True, text=True)
    else:
        binary = os.path.join(out_dir, "verify-vh")
        if _is_fresh(binary, sources):
            return binary
        notice("building RUST verifier with rustc (offline) -> %s" % binary)
        p = subprocess.run([tool_bin, "--edition", "2021", "-O", "-o", binary,
                            os.path.join("src", "main.rs")],
                           cwd=RS_SRC_DIR, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError("rust build FAILED (toolchain present, landed sources did not build):\n"
                           + p.stdout + p.stderr)
    return binary


def discover_impls():
    """Return an ordered list of {name, argv-prefix} for every PRESENT leg."""
    impls = []

    node = find_node()
    if node and os.path.exists(JS_VERIFIER):
        impls.append({"name": "JS", "cmd": [node, JS_VERIFIER]})
    else:
        notice("SKIP JS: no `node` found (checked $VH_NODE_BIN, PATH) — leg skipped")

    if os.path.exists(PY_VERIFIER):
        impls.append({"name": "PY", "cmd": [sys.executable, PY_VERIFIER]})
    else:
        notice("SKIP PY: %s not found — leg skipped" % PY_VERIFIER)

    go_bin = find_go()
    if go_bin:
        impls.append({"name": "GO", "cmd": [build_go(go_bin)]})
    else:
        notice("SKIP GO: no Go toolchain found (checked $VH_GO_BIN, $GOROOT, PATH) — leg skipped")

    rust = find_rust()
    if rust:
        impls.append({"name": "RUST", "cmd": [build_rust(*rust)]})
    else:
        notice("SKIP RUST: no cargo/rustc found (checked $VH_CARGO_BIN, $CARGO_HOME, "
               "$VH_RUSTC_BIN, PATH) — leg skipped")

    return impls


# ---------------------------------------------------------------------------
# Running the matrix.
# ---------------------------------------------------------------------------

def run_impl(impl, case, mode):
    """Return (verdict, accepted, exit_code) for one impl on one case+mode."""
    argv = list(impl["cmd"]) + [
        case["packetRelPath"],
        "--vendor", case["vendor"],
        "--dir", case["filesDirRelPath"],
        "--json",
    ]
    if mode == "exact-dir":
        argv.append("--exact-dir")
    try:
        p = subprocess.run(argv, cwd=VECTORS_DIR, capture_output=True, text=True, timeout=300)
    except Exception as e:  # pragma: no cover
        return ("<exec-error:%s>" % e, None, -1)
    verdict = "<no-json>"
    accepted = None
    try:
        d = json.loads(p.stdout)
        verdict = d.get("verdict")
        accepted = d.get("accepted")
    except Exception:
        pass
    return (verdict, accepted, p.returncode)


def expected_signature(case, mode):
    """The (verdict, exit) the present impls must agree on for case+mode."""
    if mode == "default" and case["name"] in BOUNDARY_CASES:
        # BY DESIGN: default --dir verifies the NAMED file set only, so the
        # injected extra is not covered and every impl ACCEPTs. --exact-dir is
        # the mode the vector's expected REJECT applies to (T-75.5).
        return DEFAULT_MODE_BOUNDARY_SIG
    token = {"ACCEPT": "OK", "REJECT": "REJECTED"}.get(case["expectedVerdict"],
                                                       case["expectedVerdict"])
    return (token, case["expectedExit"])


def print_matrix(impl_names, rows):
    width = 20 + 16 * (len(impl_names) + 1)
    print("=" * width)
    print("CONFORMANCE MATRIX  (verdict/exit)  present impls compared byte-for-byte to each other")
    print("=" * width)
    header = "%-28s" % "case (mode)"
    for n in impl_names:
        header += " | %-13s" % n
    header += " | %-14s" % "must equal"
    print(header)
    print("-" * width)
    for r in rows:
        line = "%-28s" % ("%s (%s)" % (r["name"], r["mode"]))
        for n in impl_names:
            v, _a, e = r["results"][n]
            line += " | %-13s" % ("%s/%s" % (v, e))
        line += " | %-14s" % ("%s/%s" % r["expected_sig"])
        flag = ""
        if not r["impls_agree"]:
            flag = "  <== IMPLS DISAGREE"
        elif not r["matches_expected"]:
            flag = "  <== OFF-SPEC"
        print(line + flag)
    print("=" * width)


def main():
    with open(VECTORS_JSON) as f:
        vectors = json.load(f)
    cases = vectors["cases"]

    impls = discover_impls()
    impl_names = [i["name"] for i in impls]
    if not impls:
        print("VERDICT: FAIL — no verifier implementation could be run at all.")
        sys.exit(1)
    notice("present implementations: %s (of JS, PY, GO, RUST)" % ", ".join(impl_names))

    rows = []
    failures = []
    for case in cases:
        for mode in MODES:
            results = {i["name"]: run_impl(i, case, mode) for i in impls}
            signatures = {(r[0], r[2]) for r in results.values()}
            impls_agree = len(signatures) == 1
            exp_sig = expected_signature(case, mode)
            matches_expected = impls_agree and next(iter(signatures)) == exp_sig
            rows.append({
                "name": case["name"],
                "mode": mode,
                "results": results,
                "expected_sig": exp_sig,
                "impls_agree": impls_agree,
                "matches_expected": matches_expected,
            })
            if not impls_agree:
                failures.append(("DIVERGENCE", case["name"], mode, results))
            elif not matches_expected:
                failures.append(("OFF-SPEC", case["name"], mode, results))

    print_matrix(impl_names, rows)
    print()

    if failures:
        print("=" * 72)
        print("!!!!!!!!!!!!!!!!!!!!!!  C O N F O R M A N C E   F A I L  !!!!!!!!!!!!!!")
        print("=" * 72)
        for kind, name, mode, results in failures:
            if kind == "DIVERGENCE":
                print("  CASE '%s' (%s mode): the present verifiers DISAGREE with each other:" % (name, mode))
            else:
                print("  CASE '%s' (%s mode): impls agree with each other but NOT with the vector expected:" % (name, mode))
            for impl_name, (v, a, e) in results.items():
                print("      %-4s -> verdict=%s accepted=%s exit=%s" % (impl_name, v, a, e))
        print("=" * 72)
        print()
        print("VERDICT: FAIL — see the banner above (a divergence names its case).")
        sys.exit(1)

    print("  %d-WAY AGREEMENT: %s are byte-identical in verdict+exit on every case," % (len(impls), " == ".join(impl_names)))
    print("  in BOTH default and --exact-dir modes, and match the vector expectations.")
    print("  (`extra-file` goes GREEN under --exact-dir — T-75.5 landed in all impls; its")
    print("   default-mode ACCEPT is the seal's BY-DESIGN named-file-set boundary.)")
    print()
    print("VERDICT: PASS")
    sys.exit(0)


if __name__ == "__main__":
    main()

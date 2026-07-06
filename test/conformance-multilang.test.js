"use strict";

// test/conformance-multilang.test.js — EPIC-77 / T-77.1: the multi-language conformance gate.
//
// THE CLAIM THIS PINS: verifyhash's #1 value prop is "verify INDEPENDENTLY" — and the strongest
// possible evidence is FOUR clean-room implementations in four languages (JS, Python, Go, Rust)
// with ZERO shared dependencies producing the SAME verdict + exit code on one frozen vector suite
// (verify-vectors/vectors.json). A bug or backdoor would have to exist identically in all four.
//
// WHAT RUNS: every case in the frozen vectors, through every implementation PRESENT on this
// machine, in BOTH modes:
//   * default --dir mode   — the seal's honest named-file-set semantics;
//   * --exact-dir mode     — the fail-closed whole-directory gate (T-75.5).
// The JS implementation (verifier/verify-vh.js) ALWAYS runs (node is running this test). The
// Python leg SKIPS (green, with a visible notice) when `python3` is absent; the Go leg when no
// Go >= 1.22 toolchain is found ($VH_GO_BIN, $GOROOT, PATH); the Rust leg when neither cargo nor
// rustc >= 1.56 is found ($VH_CARGO_BIN, $CARGO_HOME, $VH_RUSTC_BIN, PATH). Go/Rust binaries are
// built HERMETICALLY OFFLINE from the landed sources (GOPROXY=off / cargo --offline) into an OS
// temp build dir — never into the repo tree.
//
// THE `extra-file` CASE (the once-documented shared gap): T-75.5 LANDED, and this task ported
// `--exact-dir` to all four implementations — so extra-file must go GREEN (REJECTED/3, matching
// the vector's expected) for EVERY present implementation under --exact-dir. Its default-mode
// ACCEPT/0 is asserted too, as the seal's BY-DESIGN named-file-set boundary (a seal binds a named
// set, not a directory; --exact-dir is the mode that closes the boundary).
//
// A REAL DIVERGENCE (two present implementations disagree) fails LOUDLY, naming the case and
// printing the full per-implementation matrix — and that failure shape is itself unit-tested
// below against a synthetic divergence, so the loud-failure path can never silently rot.
//
// OFFLINE: no network anywhere (builds are --offline; verifiers read only local files).
// NO NEW JS DEPENDENCY: node builtins + chai only.

const { expect } = require("chai");
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
const VECTORS_DIR = path.join(REPO, "verify-vectors");
const VECTORS = JSON.parse(fs.readFileSync(path.join(VECTORS_DIR, "vectors.json"), "utf8"));
const CASES = VECTORS.cases;

const JS_VERIFIER = path.join(REPO, "verifier", "verify-vh.js");
const PY_VERIFIER = path.join(REPO, "verifier-py", "verify_vh.py");
const GO_SRC_DIR = path.join(REPO, "verifier-go");
const RS_SRC_DIR = path.join(REPO, "verifier-rs");

const IMPL_NAMES = ["JS", "PY", "GO", "RUST"];
const MODES = ["default", "exact-dir"];

// The one case whose DEFAULT-mode answer intentionally differs from the vector expected: a seal
// binds a NAMED FILE SET, so default --dir ACCEPTs an unsealed extra file (by design, T-75.5
// documented). The vector's expected REJECT applies to --exact-dir mode, where it must go GREEN.
const BOUNDARY_CASE = "extra-file";
const DEFAULT_MODE_BOUNDARY_SIG = { verdict: "OK", exit: 0 };

// ---------------------------------------------------------------------------------------------
// Pure assessment helpers (unit-tested below — the loud-failure contract lives here).
// ---------------------------------------------------------------------------------------------

// Byte-identical agreement across present impls on (verdict, exit). Returns { agree, message };
// on disagreement the message NAMES the case and prints the full matrix.
function assessAgreement(caseName, mode, resultsByImpl) {
  const signatures = new Set(
    Object.values(resultsByImpl).map((r) => `${r.verdict}/${r.exit}`)
  );
  if (signatures.size <= 1) return { agree: true, message: "" };
  const matrix = Object.entries(resultsByImpl)
    .map(([name, r]) => `  ${name} -> verdict=${r.verdict} exit=${r.exit}`)
    .join("\n");
  return {
    agree: false,
    message:
      `DIVERGENCE in case '${caseName}' (${mode} mode): the present implementations DISAGREE ` +
      `on verdict/exit:\n${matrix}`,
  };
}

// The (verdict, exit) every present impl must produce for a case+mode.
function expectedSignature(c, mode) {
  if (mode === "default" && c.name === BOUNDARY_CASE) return DEFAULT_MODE_BOUNDARY_SIG;
  return {
    verdict: c.expectedVerdict === "ACCEPT" ? "OK" : "REJECTED",
    exit: c.expectedExit,
  };
}

// Every impl's answer must equal the expected signature. Returns { ok, message } naming the
// case + every off-spec implementation.
function assessExpected(caseName, mode, resultsByImpl, expected) {
  const offSpec = Object.entries(resultsByImpl).filter(
    ([, r]) => !(r.verdict === expected.verdict && r.exit === expected.exit)
  );
  if (offSpec.length === 0) return { ok: true, message: "" };
  const matrix = offSpec
    .map(([name, r]) => `  ${name} -> verdict=${r.verdict} exit=${r.exit}`)
    .join("\n");
  return {
    ok: false,
    message:
      `case '${caseName}' (${mode} mode): expected verdict=${expected.verdict} ` +
      `exit=${expected.exit} but got:\n${matrix}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Toolchain discovery (env first, then PATH) — a missing toolchain SKIPS its leg, never fails.
// ---------------------------------------------------------------------------------------------

function which(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

// Run `bin args` and return combined stdout+stderr on exit 0, else null.
function probe(bin, args) {
  try {
    const r = spawnSync(bin, args, { encoding: "utf8", timeout: 60000 });
    if (r.status !== 0) return null;
    return (r.stdout || "") + (r.stderr || "");
  } catch {
    return null;
  }
}

// First "x.y" version number in text, as [x, y] — or null.
function parseVersion(text) {
  const m = /(\d+)\.(\d+)/.exec(text || "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function versionAtLeast(v, min) {
  return v != null && (v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1]));
}

function findPython3() {
  const candidates = [process.env.VH_PYTHON3_BIN, which("python3")].filter(Boolean);
  for (const c of candidates) if (probe(c, ["--version"]) != null) return c;
  return null;
}

function findGo() {
  const candidates = [
    process.env.VH_GO_BIN,
    process.env.GOROOT ? path.join(process.env.GOROOT, "bin", "go") : null,
    which("go"),
  ].filter(Boolean);
  for (const c of candidates) {
    const out = probe(c, ["version"]);
    if (out == null) continue;
    if (!versionAtLeast(parseVersion(out), [1, 22])) return null; // older than the go.mod pin
    return c;
  }
  return null;
}

// Returns { kind: "cargo"|"rustc", bin } or null.
function findRust() {
  const cargoCandidates = [
    process.env.VH_CARGO_BIN,
    process.env.CARGO_HOME ? path.join(process.env.CARGO_HOME, "bin", "cargo") : null,
    which("cargo"),
  ].filter(Boolean);
  for (const c of cargoCandidates) {
    const out = probe(c, ["--version"]);
    if (out == null) continue;
    if (!versionAtLeast(parseVersion(out), [1, 56])) return null; // pre-edition-2021
    return { kind: "cargo", bin: c };
  }
  const rustcCandidates = [process.env.VH_RUSTC_BIN, which("rustc")].filter(Boolean);
  for (const c of rustcCandidates) {
    const out = probe(c, ["--version"]);
    if (out == null) continue;
    if (!versionAtLeast(parseVersion(out), [1, 56])) return null;
    return { kind: "rustc", bin: c };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Hermetic OFFLINE builds of the Go/Rust verifiers, into an OS temp dir (never the repo tree).
// The build dir is stable per repo path so warm rebuilds are mtime-skipped.
// ---------------------------------------------------------------------------------------------

const BUILD_ROOT =
  process.env.VH_CONFORMANCE_BUILD_DIR ||
  path.join(
    os.tmpdir(),
    "vh-conformance-" +
      crypto.createHash("sha256").update(fs.realpathSync(REPO)).digest("hex").slice(0, 12)
  );

function newestMtimeMs(files) {
  let newest = 0;
  for (const f of files) {
    try {
      newest = Math.max(newest, fs.statSync(f).mtimeMs);
    } catch {
      /* vanished file: ignore */
    }
  }
  return newest;
}

function isFresh(binary, sources) {
  try {
    return fs.statSync(binary).mtimeMs >= newestMtimeMs(sources);
  } catch {
    return false;
  }
}

function buildGo(goBin) {
  const outDir = path.join(BUILD_ROOT, "go");
  fs.mkdirSync(outDir, { recursive: true });
  const binary = path.join(outDir, "verify-vh");
  const sources = fs
    .readdirSync(GO_SRC_DIR)
    .filter((f) => f.endsWith(".go") || f === "go.mod")
    .map((f) => path.join(GO_SRC_DIR, f));
  if (isFresh(binary, sources)) return binary;
  const env = {
    ...process.env,
    GOFLAGS: "-mod=readonly",
    GOPROXY: "off", // hermetic: no module downloads (the module has zero requires)
    GOSUMDB: "off",
    GOTOOLCHAIN: "local", // hermetic: never auto-download a newer toolchain
    CGO_ENABLED: "0",
    GOCACHE: path.join(outDir, "gocache"),
    GOMODCACHE: path.join(outDir, "gomodcache"),
  };
  const r = spawnSync(goBin, ["build", "-o", binary, "."], {
    cwd: GO_SRC_DIR,
    env,
    encoding: "utf8",
    timeout: 300000,
  });
  if (r.status !== 0) {
    throw new Error(
      `go build FAILED (toolchain present; the landed verifier-go sources did not build):\n` +
        `${r.stdout || ""}${r.stderr || ""}`
    );
  }
  return binary;
}

function buildRust(toolchain) {
  const outDir = path.join(BUILD_ROOT, "rust");
  fs.mkdirSync(outDir, { recursive: true });
  const srcDir = path.join(RS_SRC_DIR, "src");
  const sources = fs
    .readdirSync(srcDir)
    .map((f) => path.join(srcDir, f))
    .concat([path.join(RS_SRC_DIR, "Cargo.toml"), path.join(RS_SRC_DIR, "Cargo.lock")]);
  let binary;
  let r;
  if (toolchain.kind === "cargo") {
    binary = path.join(outDir, "target", "release", "verify-vh");
    if (isFresh(binary, sources)) return binary;
    r = spawnSync(
      toolchain.bin,
      ["build", "--release", "--offline", "--target-dir", path.join(outDir, "target")],
      {
        cwd: RS_SRC_DIR,
        env: { ...process.env, CARGO_NET_OFFLINE: "true" },
        encoding: "utf8",
        timeout: 600000,
      }
    );
  } else {
    binary = path.join(outDir, "verify-vh");
    if (isFresh(binary, sources)) return binary;
    r = spawnSync(
      toolchain.bin,
      ["--edition", "2021", "-O", "-o", binary, path.join("src", "main.rs")],
      { cwd: RS_SRC_DIR, encoding: "utf8", timeout: 600000 }
    );
  }
  if (r.status !== 0) {
    throw new Error(
      `rust build FAILED (toolchain present; the landed verifier-rs sources did not build):\n` +
        `${r.stdout || ""}${r.stderr || ""}`
    );
  }
  return binary;
}

// ---------------------------------------------------------------------------------------------
// Running one implementation on one case+mode.
// ---------------------------------------------------------------------------------------------

function runImpl(impl, c, mode) {
  const args = [
    ...impl.argvPrefix,
    c.packetRelPath,
    "--vendor",
    c.vendor,
    "--dir",
    c.filesDirRelPath,
    "--json",
  ];
  if (mode === "exact-dir") args.push("--exact-dir");
  const r = spawnSync(impl.bin, args, { cwd: VECTORS_DIR, encoding: "utf8", timeout: 300000 });
  let verdict = "<no-json>";
  let accepted = null;
  try {
    const d = JSON.parse(r.stdout);
    verdict = d.verdict;
    accepted = d.accepted;
  } catch {
    /* non-JSON output surfaces as <no-json>, which can never agree with a real verdict */
  }
  return { verdict, accepted, exit: r.status == null ? `<killed:${r.signal}>` : r.status };
}

// ---------------------------------------------------------------------------------------------
// The suite.
// ---------------------------------------------------------------------------------------------

describe("multi-language conformance: JS = PY = GO = RUST over the frozen vectors (T-77.1)", function () {
  // Builds (cold Go/Rust) + up to 4 impls x 6 cases x 2 modes of child processes.
  this.timeout(900000);

  /** @type {Array<{name: string, bin: string, argvPrefix: string[]}>} */
  let impls;
  /** results[caseName][mode][implName] = { verdict, accepted, exit } */
  let results;
  /** skipNotices[implName] = human reason, for legs that are absent */
  let skipNotices;

  before(function () {
    impls = [];
    skipNotices = {};

    // JS — ALWAYS present: the very node running this test executes the reference verifier.
    impls.push({ name: "JS", bin: process.execPath, argvPrefix: [JS_VERIFIER] });

    const py = findPython3();
    if (py) impls.push({ name: "PY", bin: py, argvPrefix: [PY_VERIFIER] });
    else skipNotices.PY = "no `python3` found (checked $VH_PYTHON3_BIN, PATH)";

    const goBin = findGo();
    if (goBin) impls.push({ name: "GO", bin: buildGo(goBin), argvPrefix: [] });
    else skipNotices.GO = "no Go >= 1.22 toolchain found (checked $VH_GO_BIN, $GOROOT, PATH)";

    const rust = findRust();
    if (rust) impls.push({ name: "RUST", bin: buildRust(rust), argvPrefix: [] });
    else
      skipNotices.RUST =
        "no cargo/rustc >= 1.56 found (checked $VH_CARGO_BIN, $CARGO_HOME, $VH_RUSTC_BIN, PATH)";

    for (const [name, reason] of Object.entries(skipNotices)) {
      // Visible notice, as the acceptance demands — the leg SKIPS, it never fails.
      console.log(`      [conformance-multilang] SKIP ${name}: ${reason}`);
    }
    console.log(
      `      [conformance-multilang] present implementations: ${impls
        .map((i) => i.name)
        .join(", ")} (of ${IMPL_NAMES.join(", ")})`
    );

    results = {};
    for (const c of CASES) {
      results[c.name] = {};
      for (const mode of MODES) {
        results[c.name][mode] = {};
        for (const impl of impls) {
          results[c.name][mode][impl.name] = runImpl(impl, c, mode);
        }
      }
    }
  });

  // ------------------------------------------------------------------------------------------
  // Vector-suite sanity: this gate must never green by running over nothing.
  // ------------------------------------------------------------------------------------------

  it("the frozen vector suite is intact: >= 6 cases including the extra-file boundary case", function () {
    expect(CASES.length).to.be.at.least(6);
    const names = CASES.map((c) => c.name);
    for (const required of [
      "genuine-single",
      "genuine-multi",
      "tampered-file",
      "wrong-vendor",
      "missing-file",
      "extra-file",
    ]) {
      expect(names, `vectors.json must carry the '${required}' case`).to.include(required);
    }
  });

  it("the JS reference implementation ran every case in both modes (always present)", function () {
    expect(impls.map((i) => i.name)).to.include("JS");
    for (const c of CASES) {
      for (const mode of MODES) {
        const r = results[c.name][mode].JS;
        expect(r, `JS must have a result for '${c.name}' (${mode})`).to.not.equal(undefined);
        expect(r.verdict, `JS produced no JSON verdict for '${c.name}' (${mode})`).to.be.oneOf([
          "OK",
          "REJECTED",
        ]);
      }
    }
  });

  // ------------------------------------------------------------------------------------------
  // The loud-failure contract, unit-tested against a SYNTHETIC divergence — so the "a real
  // divergence fails loudly naming the case" path can never silently rot.
  // ------------------------------------------------------------------------------------------

  it("a real divergence fails loudly, naming the case and the disagreeing implementations", function () {
    const divergent = {
      JS: { verdict: "REJECTED", accepted: false, exit: 3 },
      PY: { verdict: "REJECTED", accepted: false, exit: 3 },
      GO: { verdict: "OK", accepted: true, exit: 0 }, // the synthetic traitor
      RUST: { verdict: "REJECTED", accepted: false, exit: 3 },
    };
    const a = assessAgreement("tampered-file", "default", divergent);
    expect(a.agree).to.equal(false);
    expect(a.message).to.include("DIVERGENCE");
    expect(a.message).to.include("tampered-file"); // names the case
    expect(a.message).to.include("GO -> verdict=OK exit=0"); // names the disagreeing impl
    // And byte-identical answers do NOT trip it:
    const agreed = assessAgreement("tampered-file", "default", {
      JS: { verdict: "REJECTED", exit: 3 },
      PY: { verdict: "REJECTED", exit: 3 },
    });
    expect(agreed.agree).to.equal(true);
  });

  it("an agreed-but-off-spec answer fails loudly too, naming the case", function () {
    const offSpec = {
      JS: { verdict: "OK", accepted: true, exit: 0 },
      PY: { verdict: "OK", accepted: true, exit: 0 },
    };
    const a = assessExpected("missing-file", "default", offSpec, {
      verdict: "REJECTED",
      exit: 3,
    });
    expect(a.ok).to.equal(false);
    expect(a.message).to.include("missing-file");
    expect(a.message).to.include("expected verdict=REJECTED exit=3");
  });

  // ------------------------------------------------------------------------------------------
  // Per-case conformance: byte-identical agreement across present impls, and vs the expected.
  // ------------------------------------------------------------------------------------------

  for (const c of CASES) {
    describe(`case '${c.name}'`, function () {
      for (const mode of MODES) {
        it(`all present implementations agree byte-identically on verdict+exit (${mode} mode)`, function () {
          const a = assessAgreement(c.name, mode, results[c.name][mode]);
          expect(a.agree, a.message).to.equal(true);
        });
      }

      it(
        c.name === BOUNDARY_CASE
          ? "matches the vector expected: GREEN (REJECTED/3) under --exact-dir for EVERY " +
              "present impl (T-75.5 landed), ACCEPT/0 in default mode (by-design named-set boundary)"
          : "matches the vector's expected verdict+exit in both modes",
        function () {
          for (const mode of MODES) {
            const expected = expectedSignature(c, mode);
            const a = assessExpected(c.name, mode, results[c.name][mode], expected);
            expect(a.ok, a.message).to.equal(true);
          }
        }
      );
    });
  }

  // ------------------------------------------------------------------------------------------
  // Per-leg presence: PY/GO/RUST each ran everything, or SKIP green with the visible notice.
  // ------------------------------------------------------------------------------------------

  for (const legName of ["PY", "GO", "RUST"]) {
    it(`${legName} implementation is exercised over every case (skips when its toolchain is absent)`, function () {
      if (!impls.some((i) => i.name === legName)) {
        console.log(`      [conformance-multilang] SKIP ${legName}: ${skipNotices[legName]}`);
        this.skip();
        return;
      }
      for (const c of CASES) {
        for (const mode of MODES) {
          const r = results[c.name][mode][legName];
          expect(r, `${legName} must have a result for '${c.name}' (${mode})`).to.not.equal(
            undefined
          );
          expect(
            r.verdict,
            `${legName} produced no JSON verdict for '${c.name}' (${mode})`
          ).to.be.oneOf(["OK", "REJECTED"]);
        }
      }
    });
  }
});

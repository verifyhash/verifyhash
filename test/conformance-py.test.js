"use strict";

// test/conformance-py.test.js — T-76.1: the Python<->JS conformance gate, wired into the repo suite.
//
// THE CLAIM THIS PINS: the pure-Python verifier (verifier-py/verify_vh.py) is a REAL second
// implementation — on the SAME inputs it returns the BYTE-IDENTICAL ACCEPT/REJECT decision AND the
// IDENTICAL process exit code (0 accept / 3 reject) as the reference JS verifier
// (verifier/verify-vh.js). Unlike the frozen-vector gate (test/conformance-multilang.test.js), this
// suite exercises the LIVE producer path end-to-end: it seals a FRESH genuine packet through the
// shipped CLI on every run, so a producer-side drift (canonicalization, Merkle leaf shape, signing
// envelope) that the frozen vectors would miss is caught here.
//
// FIXTURES — EPHEMERAL, NEVER A REAL KEY:
//   * the signing key is an in-process `Wallet.createRandom()` (TEST-ONLY; never the operator
//     self-license, never a funded/real key, never argv, never written to disk — it reaches the
//     CLI children ONLY via `--key-env`);
//   * the paid `--sign` gate is re-pinned to the ephemeral identity for the child processes via the
//     DOCUMENTED self-hosting hook `VH_CANONICAL_VENDOR` (cli/core/vendor-identity.js), and an
//     ephemeral test license is minted with the same throwaway key — so no committed/operator
//     credential is ever touched;
//   * the genuine packet is sealed by the SHIPPED producer:
//     `node cli/vh.js evidence seal <dir> --sign --key-env … --license … --vendor … --out …`.
//
// THE FOUR CASES (each run through BOTH verifiers with --json):
//   1. genuine packet + correct vendor        -> ACCEPT, exit 0
//   2. tampered file (one byte flipped)       -> REJECT, exit 3
//   3. correct packet + WRONG vendor address  -> REJECT, exit 3
//   4. a missing referenced file              -> REJECT, exit 3
//
// A DIVERGENCE (the two verifiers DISAGREE on the same input) fails LOUDLY, NAMING the case and
// printing both verdicts — and that loud-failure shape is itself unit-tested below against a
// synthetic divergence, so the divergence path can never silently rot.
//
// SKIP CONTRACT: when no working `python3` is found (probe: `python3 --version`, plus the
// $VH_PYTHON3_BIN override the multilang gate honors), the WHOLE suite SKIPS cleanly (pending,
// green) — it NEVER fails for a missing interpreter.
//
// OFFLINE: no network anywhere — the only child processes are local node/python3 runs.
// NO NEW DEPENDENCY: node builtins + chai + the repo's existing ethers (JS); Python stdlib only.

const { expect } = require("chai");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Wallet } = require("ethers");

const REPO = path.join(__dirname, "..");
const VH_CLI = path.join(REPO, "cli", "vh.js");
const JS_VERIFIER = path.join(REPO, "verifier", "verify-vh.js");
const PY_VERIFIER = path.join(REPO, "verifier-py", "verify_vh.py");
const PY_HARNESS = path.join(REPO, "verifier-py", "conformance.py");

// The env var the EPHEMERAL private key travels through (never argv, never disk).
const KEY_ENV = "VH_CONFORMANCE_TEST_KEY";

// A valid-format address that can never be the ephemeral signer (asserted below).
const WRONG_VENDOR = "0x1111111111111111111111111111111111111111";

// ---------------------------------------------------------------------------------------------
// python3 discovery — a missing interpreter SKIPS the suite, never fails it.
// ---------------------------------------------------------------------------------------------

function probe(bin, args) {
  try {
    const r = spawnSync(bin, args, { encoding: "utf8", timeout: 60000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

function findPython3() {
  const candidates = [process.env.VH_PYTHON3_BIN, "python3"].filter(Boolean);
  for (const c of candidates) if (probe(c, ["--version"])) return c;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Pure assessment helper (unit-tested below — the loud DIVERGENCE contract lives here).
// Byte-identical agreement on the ACCEPT/REJECT decision label AND the exit code; on
// disagreement the message NAMES the case and prints both sides.
// ---------------------------------------------------------------------------------------------

function decisionLabel(r) {
  if (r.accepted === true) return "ACCEPT";
  if (r.accepted === false) return "REJECT";
  return "ERROR"; // no parseable decision — can never byte-equal a real one
}

function assessAgreement(caseName, js, py) {
  const jsSig = `${decisionLabel(js)}/${js.exit}`;
  const pySig = `${decisionLabel(py)}/${py.exit}`;
  // Byte-identical comparison of the decision signatures (decision label + exit code).
  if (Buffer.compare(Buffer.from(jsSig, "utf8"), Buffer.from(pySig, "utf8")) === 0) {
    return { agree: true, message: "" };
  }
  return {
    agree: false,
    message:
      `DIVERGENCE in case '${caseName}': the JS and Python verifiers DISAGREE on the same input:\n` +
      `  JS -> ${jsSig} (verdict=${js.verdict} reason=${js.reason})\n` +
      `  PY -> ${pySig} (verdict=${py.verdict} reason=${py.reason})`,
  };
}

// ---------------------------------------------------------------------------------------------
// Fixture + runner plumbing.
// ---------------------------------------------------------------------------------------------

function runOne(bin, argvPrefix, args, env) {
  const r = spawnSync(bin, [...argvPrefix, ...args, "--json"], {
    cwd: REPO,
    env,
    encoding: "utf8",
    timeout: 120000,
  });
  let verdict = "<no-json>";
  let reason = "<no-json>";
  let accepted = null;
  try {
    const d = JSON.parse(r.stdout);
    verdict = d.verdict;
    reason = d.reason;
    accepted = d.accepted;
  } catch {
    /* non-JSON output stays <no-json>/null, which can never agree with a real decision */
  }
  return {
    exit: r.status == null ? `<killed:${r.signal}>` : r.status,
    verdict,
    reason,
    accepted,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

// Static case metadata (the fixtures + results are built once in before()).
const CASE_EXPECTATIONS = [
  { name: "genuine+correct-vendor", expectDecision: "ACCEPT", expectExit: 0 },
  { name: "tampered-file", expectDecision: "REJECT", expectExit: 3 },
  { name: "wrong-vendor", expectDecision: "REJECT", expectExit: 3 },
  { name: "missing-file", expectDecision: "REJECT", expectExit: 3 },
];

describe("Python<->JS conformance: fresh sealed packet, byte-identical decisions (T-76.1)", function () {
  // 2 producer CLI spawns + 8 verifier spawns + the standalone Python harness (which seals its own
  // fresh packet): generous ceiling, typical run is a few seconds.
  this.timeout(300000);

  let python3; // resolved interpreter, or the suite skipped
  let workspace; // OS temp dir, removed in after()
  let wallet; // EPHEMERAL Wallet.createRandom() — in-memory only
  let packetPath;
  /** results[caseName] = { js: {...}, py: {...} } */
  let results;

  before(function () {
    python3 = findPython3();
    if (!python3) {
      // The acceptance skip contract: no python3 -> SKIP cleanly (pending), never fail.
      console.log(
        "      [conformance-py] SKIP: no working `python3` found (checked $VH_PYTHON3_BIN, PATH)"
      );
      this.skip();
      return;
    }

    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "vh-conf-py-"));

    // EPHEMERAL key (test-only): generated in-process, passed to children ONLY via --key-env.
    wallet = Wallet.createRandom();
    expect(wallet.privateKey).to.match(/^0x[0-9a-fA-F]{64}$/);
    const vendor = wallet.address;
    expect(vendor.toLowerCase()).to.not.equal(WRONG_VENDOR);
    const childEnv = {
      ...process.env,
      [KEY_ENV]: wallet.privateKey,
      // The DOCUMENTED self-hosting hook: re-pin the paid gate to the ephemeral identity for
      // these child processes only (cli/core/vendor-identity.js).
      VH_CANONICAL_VENDOR: vendor,
    };

    // 1) the directory we will seal
    const src = path.join(workspace, "src");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "report.txt"), "hello from verifyhash conformance\nline two\n");
    fs.writeFileSync(path.join(src, "data.json"), '{"k":"v","n":42}\n');

    // 2) mint an EPHEMERAL test license with the ephemeral key (valid only against the re-pinned
    //    ephemeral identity — worthless anywhere else; NEVER the operator self-license).
    const licensePath = path.join(workspace, "conformance.vhlicense.json");
    const fulfill = spawnSync(
      process.execPath,
      [
        VH_CLI, "evidence", "license", "fulfill",
        "--plan", "evidence-signed-monthly",
        "--customer", "conformance-test",
        "--key-env", KEY_ENV,
        "--out", licensePath,
      ],
      { cwd: REPO, env: childEnv, encoding: "utf8", timeout: 120000 }
    );
    expect(
      fulfill.status,
      `ephemeral license fulfill failed:\n${fulfill.stdout}\n${fulfill.stderr}`
    ).to.equal(0);

    // 3) seal the GENUINE packet through the SHIPPED producer CLI with the ephemeral key.
    packetPath = path.join(workspace, "seal-genuine.json");
    const seal = spawnSync(
      process.execPath,
      [
        VH_CLI, "evidence", "seal", src,
        "--sign",
        "--key-env", KEY_ENV,
        "--license", licensePath,
        "--vendor", vendor,
        "--out", packetPath,
      ],
      { cwd: REPO, env: childEnv, encoding: "utf8", timeout: 120000 }
    );
    expect(seal.status, `evidence seal --sign failed:\n${seal.stdout}\n${seal.stderr}`).to.equal(0);
    expect(fs.existsSync(packetPath)).to.equal(true);

    // 4) derive the case variants.
    const tampered = path.join(workspace, "files-tampered");
    fs.cpSync(src, tampered, { recursive: true });
    const tamperedFile = path.join(tampered, "report.txt");
    const bytes = fs.readFileSync(tamperedFile);
    bytes[0] ^= 0x01; // flip ONE byte
    fs.writeFileSync(tamperedFile, bytes);

    const missing = path.join(workspace, "files-missing");
    fs.cpSync(src, missing, { recursive: true });
    fs.rmSync(path.join(missing, "data.json")); // referenced but now absent

    const caseArgs = {
      "genuine+correct-vendor": [packetPath, "--vendor", vendor, "--dir", src],
      "tampered-file": [packetPath, "--vendor", vendor, "--dir", tampered],
      "wrong-vendor": [packetPath, "--vendor", WRONG_VENDOR, "--dir", src],
      "missing-file": [packetPath, "--vendor", vendor, "--dir", missing],
    };

    // 5) run BOTH verifiers on every case (plain env — the verifiers hold no key).
    results = {};
    for (const [name, args] of Object.entries(caseArgs)) {
      results[name] = {
        js: runOne(process.execPath, [JS_VERIFIER], args, process.env),
        py: runOne(python3, [PY_VERIFIER], args, process.env),
      };
    }
  });

  after(function () {
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------------------------------
  // Fixture sanity + key hygiene.
  // ------------------------------------------------------------------------------------------

  it("the genuine packet was sealed by the SHIPPED CLI with the EPHEMERAL key (and that key never touched disk)", function () {
    const packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));
    expect(packet.kind).to.equal("vh.evidence-seal-signed");
    expect(String(packet.signature && packet.signature.signer).toLowerCase()).to.equal(
      wallet.address.toLowerCase()
    );
    // KEY HYGIENE: no fixture file anywhere in the workspace contains the private key bytes
    // (the key traveled ONLY through --key-env).
    const bareKey = wallet.privateKey.slice(2).toLowerCase();
    const scan = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) scan(full);
        else {
          const content = fs.readFileSync(full, "utf8").toLowerCase();
          expect(content.includes(bareKey), `ephemeral private key LEAKED into ${full}`).to.equal(
            false
          );
        }
      }
    };
    scan(workspace);
  });

  // ------------------------------------------------------------------------------------------
  // The conformance matrix: per case, byte-identical decision + identical exit code — and BOTH
  // must match the case's expected ACCEPT/REJECT + exit (0/3).
  // ------------------------------------------------------------------------------------------

  for (const c of CASE_EXPECTATIONS) {
    it(`case '${c.name}': JS and PY agree byte-for-byte AND match expected ${c.expectDecision}/${c.expectExit}`, function () {
      const r = results[c.name];
      expect(r, `case '${c.name}' never ran`).to.exist;

      // (a) NO DIVERGENCE — a disagreement fails loudly, naming the case (bullet 3).
      const verdict = assessAgreement(c.name, r.js, r.py);
      expect(verdict.agree, verdict.message).to.equal(true);

      // (b) the shared decision + exit code equal the case's EXPECTED signature.
      for (const [impl, res] of [["JS", r.js], ["PY", r.py]]) {
        expect(
          decisionLabel(res),
          `${impl} decision for '${c.name}' (verdict=${res.verdict} reason=${res.reason})`
        ).to.equal(c.expectDecision);
        expect(res.exit, `${impl} exit code for '${c.name}'`).to.equal(c.expectExit);
      }

      // (c) stronger: the machine-readable verdict/reason strings are byte-identical too.
      expect(r.py.verdict, `case '${c.name}': JSON verdict differs between JS and PY`).to.equal(
        r.js.verdict
      );
      expect(r.py.reason, `case '${c.name}': JSON reason differs between JS and PY`).to.equal(
        r.js.reason
      );
    });
  }

  // ------------------------------------------------------------------------------------------
  // The loud-failure contract itself (bullet 3): a synthetic divergence produces a failing
  // verdict whose message NAMES the case — so the divergence path can never silently rot.
  // ------------------------------------------------------------------------------------------

  it("a DIVERGENCE fails loudly, NAMING the case (synthetic disagreement through the real assessor)", function () {
    const js = { accepted: true, exit: 0, verdict: "OK", reason: "OK" };
    const py = { accepted: false, exit: 3, verdict: "REJECTED", reason: "CHANGED" };
    const verdict = assessAgreement("synthetic-case", js, py);
    expect(verdict.agree).to.equal(false);
    expect(verdict.message).to.include("DIVERGENCE");
    expect(verdict.message).to.include("synthetic-case");
    expect(verdict.message).to.include("ACCEPT/0");
    expect(verdict.message).to.include("REJECT/3");
    // And identical results agree (the assessor is not stuck-at-fail).
    expect(assessAgreement("synthetic-case", js, { ...js }).agree).to.equal(true);
  });

  // ------------------------------------------------------------------------------------------
  // The standalone Python harness (bullet 2): de-scratched, repo-relative, ephemeral-key —
  // proven by RUNNING it from a FOREIGN working directory, and by a static source pin.
  // ------------------------------------------------------------------------------------------

  it("verifier-py/conformance.py passes standalone (exit 0) from a FOREIGN cwd — its paths are repo-relative", function () {
    const foreignCwd = fs.mkdtempSync(path.join(os.tmpdir(), "vh-conf-py-cwd-"));
    try {
      const r = spawnSync(python3, [PY_HARNESS], {
        cwd: foreignCwd, // NOT the repo: only __file__-derived paths can make this work
        env: process.env,
        encoding: "utf8",
        timeout: 240000,
      });
      expect(r.status, `conformance.py failed:\n${r.stdout}\n${r.stderr}`).to.equal(0);
      expect(r.stdout).to.include("RESULT: PASS");
      expect(r.stdout).to.include("byte-identical ACCEPT/REJECT + exit code");
    } finally {
      fs.rmSync(foreignCwd, { recursive: true, force: true });
    }
  });

  it("conformance.py is de-scratched: no absolute /home or /tmp literals, no self-license, ephemeral key only", function () {
    const src = fs.readFileSync(PY_HARNESS, "utf8");
    expect(src, "absolute /home path leaked back in").to.not.include("/home/");
    expect(src, "hard-coded /tmp path leaked back in").to.not.match(/["']\/tmp\//);
    expect(src, "operator self-license reference leaked back in").to.not.match(/selflicense/i);
    expect(src, "operator vendor-key file reference leaked back in").to.not.match(
      /verifyhash-vendor-key/i
    );
    expect(src, "the sealing key must be EPHEMERAL (Wallet.createRandom)").to.include(
      "createRandom"
    );
    expect(src, "paths must resolve from __file__").to.include("__file__");
  });
});

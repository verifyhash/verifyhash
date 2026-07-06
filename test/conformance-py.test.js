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
// T-76.2 — the DIFFERENTIAL block (second describe below) answers the hostile-CTO objection the
// four fixed cases above invite: "you only cross-checked a handful of cherry-picked cases." Instead
// of a hand-authored list it GENERATES the mutation space FROM the sealed packet's own structure —
// one byte-flip and one deletion per file the packet references (enumerated from the packet, so the
// matrix scales with it), plus every structural mutation of the packet/signature/dir — and asserts
// the two implementations reach the BYTE-IDENTICAL verdict+reason+exit on ALL of them. It further
// pins that the generated space EXERCISES THE FULL verify contract from verifier-py/SPEC.md: every
// REJECT reason (CHANGED / MISSING / UNEXPECTED / root_mismatch / path_escape / bad_signature /
// wrong_issuer / unsigned_cannot_pin_vendor) AND all four exit codes (0 accept, 3 reject, 2 usage,
// 1 IO) — so a green pass can never mean "they only agreed on ACCEPT." No verify_vh.py verdict is
// changed; this is a pure cross-implementation-agreement gate over a broad, derived corpus.
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

// =================================================================================================
// T-76.2 — DIFFERENTIAL conformance: the two implementations must agree byte-for-byte across a
// BROAD mutation space GENERATED FROM the sealed packet, spanning the FULL verifier-py/SPEC.md
// verdict contract. This is the leverage the four fixed cases above lack: agreement is proven over
// a derived corpus (one flip + one delete per referenced file, every structural mutation), not a
// cherry-picked list, and the corpus is asserted to exercise every REJECT reason + all four exit
// codes — so the gate cannot pass green on a trivially narrow ("ACCEPT only") space.
// =================================================================================================

// The COMPLETE clean-negative reason vocabulary from verifier-py/SPEC.md's exit contract (the
// `3 = REJECTED` row). The differential corpus must produce EVERY one of these, agreed by both
// implementations — otherwise the "we cross-check the whole verdict surface" claim is hollow.
const SPEC_REJECT_REASONS = [
  "CHANGED",
  "MISSING",
  "UNEXPECTED",
  "root_mismatch",
  "path_escape",
  "bad_signature",
  "wrong_issuer",
  "unsigned_cannot_pin_vendor",
];

// Seal one signed + one bare genuine packet with an EPHEMERAL key, then derive the mutation corpus.
function sealGenuine(cliArgsExtra, workspace, srcDir, childEnv, out) {
  const seal = spawnSync(
    process.execPath,
    [VH_CLI, "evidence", "seal", srcDir, ...cliArgsExtra, "--out", out],
    { cwd: REPO, env: childEnv, encoding: "utf8", timeout: 120000 }
  );
  expect(seal.status, `evidence seal failed:\n${seal.stdout}\n${seal.stderr}`).to.equal(0);
  expect(fs.existsSync(out), `seal produced no packet at ${out}`).to.equal(true);
  return out;
}

describe("Python<->JS conformance: DIFFERENTIAL over a GENERATED mutation space, FULL verdict contract (T-76.2)", function () {
  // 1 license fulfill + 2 seals + (2 verifiers × ~25 derived cases) local spawns: generous ceiling.
  this.timeout(420000);

  let python3;
  let workspace;
  let wallet;
  /** cases[] = { name, expectExit|null, expectReason|null, class } */
  let cases;
  /** results[name] = { js, py } (both from runOne with --json) */
  let results;
  let referencedFiles; // the relPaths the signed packet references (the enumeration source)

  before(function () {
    python3 = findPython3();
    if (!python3) {
      console.log(
        "      [conformance-py differential] SKIP: no working `python3` found (checked $VH_PYTHON3_BIN, PATH)"
      );
      this.skip();
      return;
    }

    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "vh-conf-py-diff-"));

    // EPHEMERAL key (test-only): in-process, to children ONLY via --key-env; never on disk, never argv.
    wallet = Wallet.createRandom();
    const vendor = wallet.address;
    expect(vendor.toLowerCase()).to.not.equal(WRONG_VENDOR);
    const childEnv = { ...process.env, [KEY_ENV]: wallet.privateKey, VH_CANONICAL_VENDOR: vendor };

    // A multi-file source tree WITH A SUBDIRECTORY, so the per-file enumeration covers a nested path.
    const src = path.join(workspace, "src");
    fs.mkdirSync(path.join(src, "sub"), { recursive: true });
    fs.writeFileSync(path.join(src, "report.txt"), "hello from verifyhash differential\nline two\n");
    fs.writeFileSync(path.join(src, "data.json"), '{"k":"v","n":42}\n');
    fs.writeFileSync(path.join(src, "sub", "note.md"), "# note\nnested body\n");

    // Mint an EPHEMERAL license (needed for the paid `--sign` gate) with the ephemeral key.
    const licensePath = path.join(workspace, "diff.vhlicense.json");
    const fulfill = spawnSync(
      process.execPath,
      [VH_CLI, "evidence", "license", "fulfill", "--plan", "evidence-signed-monthly",
        "--customer", "conformance-diff", "--key-env", KEY_ENV, "--out", licensePath],
      { cwd: REPO, env: childEnv, encoding: "utf8", timeout: 120000 }
    );
    expect(fulfill.status, `ephemeral license fulfill failed:\n${fulfill.stdout}\n${fulfill.stderr}`).to.equal(0);

    // The SIGNED genuine packet (the primary corpus source) and a BARE genuine packet (for the
    // unsigned-path reasons: unsigned_cannot_pin_vendor, path_escape, root_mismatch).
    const signedPkt = sealGenuine(
      ["--sign", "--key-env", KEY_ENV, "--license", licensePath, "--vendor", vendor],
      workspace, src, childEnv, path.join(workspace, "signed.json")
    );
    const barePkt = sealGenuine([], workspace, src, childEnv, path.join(workspace, "bare.json"));

    const signed = JSON.parse(fs.readFileSync(signedPkt, "utf8"));
    expect(signed.kind).to.equal("vh.evidence-seal-signed");
    const bare = JSON.parse(fs.readFileSync(barePkt, "utf8"));
    expect(bare.kind).to.equal("vh.evidence-seal");

    // The packet's OWN file list — the derivation source for the per-file cases (NOT hand-authored).
    referencedFiles = JSON.parse(signed.attestation).files.map((f) => f.relPath);
    expect(referencedFiles.length, "signed packet must reference multiple files").to.be.greaterThan(1);

    // --- build the corpus ---------------------------------------------------------------------
    cases = [];
    const add = (c) => cases.push(c);

    // ACCEPT baselines.
    add({ name: "genuine-signed", pkt: signedPkt, dir: src, args: ["--vendor", vendor], expectExit: 0, expectReason: "OK", class: "accept" });
    add({ name: "genuine-signed-no-vendor", pkt: signedPkt, dir: src, args: [], expectExit: 0, expectReason: "OK", class: "accept" });
    add({ name: "genuine-bare-no-vendor", pkt: barePkt, dir: src, args: [], expectExit: 0, expectReason: "OK", class: "accept" });

    // ENUMERATED FROM THE PACKET: one CHANGED (byte-flip) + one MISSING (delete) per referenced file.
    for (const rel of referencedFiles) {
      const tag = rel.replace(/[^A-Za-z0-9]/g, "_");
      const flipDir = path.join(workspace, `flip-${tag}`);
      fs.cpSync(src, flipDir, { recursive: true });
      const fp = path.join(flipDir, rel);
      const b = fs.readFileSync(fp); b[0] ^= 0x01; fs.writeFileSync(fp, b);
      add({ name: `flip:${rel}`, pkt: signedPkt, dir: flipDir, args: ["--vendor", vendor], expectExit: 3, expectReason: "CHANGED", class: "per-file-flip" });

      const delDir = path.join(workspace, `del-${tag}`);
      fs.cpSync(src, delDir, { recursive: true });
      fs.rmSync(path.join(delDir, rel));
      add({ name: `del:${rel}`, pkt: signedPkt, dir: delDir, args: ["--vendor", vendor], expectExit: 3, expectReason: "MISSING", class: "per-file-del" });
    }

    // Wrong pinned vendor (sound signature, wrong signer) -> wrong_issuer.
    add({ name: "wrong-vendor", pkt: signedPkt, dir: src, args: ["--vendor", WRONG_VENDOR], expectExit: 3, expectReason: "wrong_issuer", class: "signed-mut" });

    // Extra unsealed file: loose ACCEPTs, --exact-dir REJECTs (UNEXPECTED).
    const extraDir = path.join(workspace, "extra");
    fs.cpSync(src, extraDir, { recursive: true });
    fs.writeFileSync(path.join(extraDir, "EXTRA.txt"), "unsealed intruder\n");
    add({ name: "extra-file-loose", pkt: signedPkt, dir: extraDir, args: ["--vendor", vendor], expectExit: 0, expectReason: "OK", class: "dir-mut" });
    add({ name: "extra-file-exact", pkt: signedPkt, dir: extraDir, args: ["--vendor", vendor, "--exact-dir"], expectExit: 3, expectReason: "UNEXPECTED", class: "dir-mut" });

    // Empty --dir -> everything MISSING.
    const emptyDir = fs.mkdtempSync(path.join(workspace, "empty-"));
    add({ name: "empty-dir", pkt: signedPkt, dir: emptyDir, args: ["--vendor", vendor], expectExit: 3, expectReason: "MISSING", class: "dir-mut" });

    // Signature-block / embedded-attestation mutations. Because the signature is over the embedded
    // attestation, ANY edit to it (root, a file hash, the signer) surfaces as bad_signature — the
    // SPEC's documented override. Written as packet-JSON mutations so the FILES on disk stay genuine.
    const writeMut = (name, base, fn, meta) => {
      const p = JSON.parse(fs.readFileSync(base, "utf8"));
      fn(p);
      const f = path.join(workspace, `mut-${name}.json`);
      fs.writeFileSync(f, JSON.stringify(p));
      add({ name, pkt: f, dir: src, args: ["--vendor", vendor], ...meta });
    };
    writeMut("sig-corrupt", signedPkt, (p) => {
      const s = p.signature.signature;
      p.signature.signature = "0x" + (s[2] === "a" ? "b" : "a") + s.slice(3);
    }, { expectExit: 3, expectReason: "bad_signature", class: "sig-mut" });
    writeMut("signer-swapped", signedPkt, (p) => { p.signature.signer = WRONG_VENDOR; },
      { expectExit: 3, expectReason: "bad_signature", class: "sig-mut" });
    writeMut("embedded-root-corrupt", signedPkt, (p) => {
      const e = JSON.parse(p.attestation); e.root = "0x" + "0".repeat(64); p.attestation = JSON.stringify(e);
    }, { expectExit: 3, expectReason: "bad_signature", class: "sig-mut" });
    writeMut("embedded-filehash-corrupt", signedPkt, (p) => {
      const e = JSON.parse(p.attestation); e.files[0].contentHash = "0x" + "0".repeat(64); p.attestation = JSON.stringify(e);
    }, { expectExit: 3, expectReason: "bad_signature", class: "sig-mut" });

    // Structural / IO errors (exit 1) and USAGE errors (exit 2): no --json verdict, agreement is on
    // the EXIT CODE. (verdict/reason stay <no-json> for BOTH, which the assessor treats as equal.)
    writeMut("embedded-drop-files", signedPkt, (p) => {
      const e = JSON.parse(p.attestation); delete e.files; p.attestation = JSON.stringify(e);
    }, { expectExit: 1, expectReason: null, class: "io-err" });
    writeMut("bad-sig-scheme", signedPkt, (p) => { p.signature.scheme = "not-a-scheme"; },
      { expectExit: 1, expectReason: null, class: "io-err" });
    // Truncated JSON + a non-object top level (raw bytes, not a structured mutation).
    const truncated = path.join(workspace, "mut-truncated.json");
    fs.writeFileSync(truncated, fs.readFileSync(signedPkt, "utf8").slice(0, 60));
    add({ name: "truncated-json", pkt: truncated, dir: src, args: ["--vendor", vendor], expectExit: 1, expectReason: null, class: "io-err" });
    const notObject = path.join(workspace, "mut-notobject.json");
    fs.writeFileSync(notObject, "[1, 2, 3]");
    add({ name: "not-a-json-object", pkt: notObject, dir: src, args: ["--vendor", vendor], expectExit: 1, expectReason: null, class: "io-err" });
    // Malformed --vendor address + an unknown flag -> USAGE (exit 2).
    add({ name: "bad-vendor-format", pkt: signedPkt, dir: src, args: ["--vendor", "0xnot-hex"], expectExit: 2, expectReason: null, class: "usage-err" });
    add({ name: "unknown-flag", pkt: signedPkt, dir: src, args: ["--vendor", vendor, "--totally-unknown-flag"], expectExit: 2, expectReason: null, class: "usage-err" });

    // BARE-path reasons (the unsigned verify surface):
    add({ name: "bare-pin-vendor", pkt: barePkt, dir: src, args: ["--vendor", WRONG_VENDOR], expectExit: 3, expectReason: "unsigned_cannot_pin_vendor", class: "bare-mut" });
    writeMut("bare-root-corrupt", barePkt, (p) => { p.root = "0x" + "0".repeat(64); },
      { expectExit: 3, expectReason: "root_mismatch", class: "bare-mut" });
    // Overwrite dir/args for the bare mutations that need no vendor.
    cases[cases.length - 1].args = []; // bare-root-corrupt: re-derived root != stored -> root_mismatch
    writeMut("bare-path-escape", barePkt, (p) => { p.files[0].relPath = "../escape.txt"; },
      { expectExit: 3, expectReason: "path_escape", class: "bare-mut" });
    cases[cases.length - 1].args = [];
    writeMut("bare-abs-path", barePkt, (p) => { p.files[0].relPath = "/etc/hosts"; },
      { expectExit: 3, expectReason: "path_escape", class: "bare-mut" });
    cases[cases.length - 1].args = [];

    // --- run BOTH verifiers on every case (plain env — the verifiers hold no key) ---------------
    results = {};
    for (const c of cases) {
      const args = [c.pkt, ...(c.dir ? ["--dir", c.dir] : []), ...c.args];
      results[c.name] = {
        js: runOne(process.execPath, [JS_VERIFIER], args, process.env),
        py: runOne(python3, [PY_VERIFIER], args, process.env),
      };
    }
  });

  after(function () {
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------------------------------
  // THE differential property: on EVERY generated input the two implementations agree byte-for-byte
  // (decision label + exit code + the machine-readable verdict/reason). One disagreement fails
  // loudly, naming the case — the whole point of a second implementation.
  // ------------------------------------------------------------------------------------------
  it("agrees byte-for-byte on EVERY generated case (a single divergence fails, naming it)", function () {
    const divergences = [];
    for (const c of cases) {
      const r = results[c.name];
      expect(r, `case '${c.name}' never ran`).to.exist;
      const a = assessAgreement(c.name, r.js, r.py);
      // Decision label + exit must match; then the JSON verdict/reason strings must match too.
      if (!a.agree || r.js.verdict !== r.py.verdict || r.js.reason !== r.py.reason) {
        divergences.push(
          `${c.name}: JS=${decisionLabel(r.js)}/${r.js.exit}/${r.js.verdict}/${r.js.reason} ` +
          `PY=${decisionLabel(r.py)}/${r.py.exit}/${r.py.verdict}/${r.py.reason}`
        );
      }
    }
    expect(
      divergences.length,
      `the JS and Python verifiers DISAGREE on ${divergences.length} generated case(s):\n  ` +
        divergences.join("\n  ")
    ).to.equal(0);
  });

  // ------------------------------------------------------------------------------------------
  // The corpus is DERIVED, not hand-authored: exactly one flip + one delete per referenced file.
  // ------------------------------------------------------------------------------------------
  it("the per-file cases are ENUMERATED from the packet's own file list (they scale with the packet)", function () {
    const flips = cases.filter((c) => c.class === "per-file-flip").length;
    const dels = cases.filter((c) => c.class === "per-file-del").length;
    expect(referencedFiles.length, "packet must reference >1 file for this to be meaningful").to.be.greaterThan(1);
    expect(flips, "one CHANGED case per referenced file").to.equal(referencedFiles.length);
    expect(dels, "one MISSING case per referenced file").to.equal(referencedFiles.length);
  });

  // ------------------------------------------------------------------------------------------
  // Anti-degeneracy: the AGREED corpus must exercise the FULL SPEC verdict contract, so a green
  // pass can never secretly mean "the two only agreed on ACCEPT / a couple of reasons."
  // ------------------------------------------------------------------------------------------
  it("the AGREED corpus covers the FULL SPEC contract — every REJECT reason AND all four exit codes", function () {
    // Only consider cases where the two implementations already AGREE (the property above); this
    // gate asserts that the agreed set is BROAD, not that disagreements were swept in.
    const agreedReasons = new Set();
    const agreedExits = new Set();
    for (const c of cases) {
      const r = results[c.name];
      const agree =
        assessAgreement(c.name, r.js, r.py).agree &&
        r.js.verdict === r.py.verdict &&
        r.js.reason === r.py.reason;
      if (!agree) continue;
      agreedExits.add(r.js.exit);
      if (typeof r.js.reason === "string" && r.js.reason !== "<no-json>") agreedReasons.add(r.js.reason);
    }
    // Every clean-negative reason in the SPEC exit contract is present …
    for (const reason of SPEC_REJECT_REASONS) {
      expect(agreedReasons.has(reason), `SPEC REJECT reason NOT exercised by the agreed corpus: ${reason}`).to.equal(true);
    }
    // … plus the ACCEPT reason, and all four exit codes (0 accept / 3 reject / 2 usage / 1 IO).
    expect(agreedReasons.has("OK"), "the ACCEPT reason (OK) must be exercised").to.equal(true);
    for (const code of [0, 1, 2, 3]) {
      expect(agreedExits.has(code), `SPEC exit code NOT exercised by the agreed corpus: ${code}`).to.equal(true);
    }
  });

  // ------------------------------------------------------------------------------------------
  // Where the SPEC fixes the verdict, BOTH implementations must hit that exact verdict — the
  // differential proves they AGREE; this proves they agree ON THE RIGHT ANSWER, not on a shared bug.
  // ------------------------------------------------------------------------------------------
  it("each pinned case reaches its SPEC-mandated exit (and reason, where the SPEC fixes one)", function () {
    for (const c of cases) {
      const r = results[c.name];
      for (const [impl, res] of [["JS", r.js], ["PY", r.py]]) {
        expect(res.exit, `${impl} exit for '${c.name}' (verdict=${res.verdict} reason=${res.reason})`).to.equal(c.expectExit);
        if (c.expectReason !== null) {
          expect(res.reason, `${impl} reason for '${c.name}'`).to.equal(c.expectReason);
        }
      }
    }
  });

  // ------------------------------------------------------------------------------------------
  // KEY HYGIENE: the ephemeral signing key never touched disk (it traveled only through --key-env).
  // ------------------------------------------------------------------------------------------
  it("the ephemeral signing key never touched any file in the workspace", function () {
    const bareKey = wallet.privateKey.slice(2).toLowerCase();
    const scan = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) scan(full);
        else expect(
          fs.readFileSync(full, "utf8").toLowerCase().includes(bareKey),
          `ephemeral private key LEAKED into ${full}`
        ).to.equal(false);
      }
    };
    scan(workspace);
  });
});

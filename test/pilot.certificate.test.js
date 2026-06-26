"use strict";

// ---------------------------------------------------------------------------
// T-53.2 — `node pilot/run-pilot.js --certificate <path>` SEALS the pilot result into a tamper-evident,
// independently-verifiable `*.vhevidence.json` certificate, by DOGFOODING the SHIPPED `cli/evidence.js`
// seal core. These tests prove the EPIC-53 invariant, each criterion pinned to a case:
//
//   * With --certificate a `*.vhevidence.json` packet IS written, and the INDEPENDENT verifier
//     (verifier/verify-vh.js — js-sha3 only, NO ethers/hardhat) ACCEPTS it (exit 0) and RE-DERIVES the
//     keccak root from the BYTES it ships alongside (rootMatches: true). Driven through the REAL verifier
//     (a child process for the unsigned accept/reject, AND the in-process module) — NEVER a false ACCEPT.
//   * A ONE-BYTE tamper of the sealed result bytes makes verify-vh REJECT (exit 3) and LOCALIZE the change
//     to exactly the sealed file. (We never assert ACCEPT without first proving REJECT on a mutation.)
//   * With NO --certificate, NO file is written and the run's stdout + exit code are BYTE-FOR-BYTE the
//     pre-EPIC baseline (after masking ONLY the random ephemeral vendor-address detail that was already
//     non-deterministic). Regression-pinned against a real subprocess run.
//   * The OPTIONAL `--sign --vendor <addr>` path produces a SIGNED certificate whose recovered signer is
//     the EPHEMERAL operator key, which `vh evidence verify-signed` (and verify-vh --vendor) ACCEPT pinned
//     to that vendor — and a tamper still REJECTS.
//   * No real key is held (only Wallet.createRandom()), no network, no new dependency. The repo working
//     tree (and cwd) is left CLEAN, pass or fail.
//
// Fully OFFLINE/no-key/no-network: no hardhat node, no provider. Every filesystem effect is isolated to a
// throwaway temp dir and cleaned up.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Wallet } = require("ethers");

const REPO = path.resolve(__dirname, "..");
const RUN_JS = path.join(REPO, "pilot", "run-pilot.js");
const VERIFY_VH = path.join(REPO, "verifier", "verify-vh.js");

const pilot = require("../pilot/run-pilot");
const evidence = require("../cli/evidence");
const verifyVh = require("../verifier/verify-vh");

// Mask the ONLY intentionally-nondeterministic bytes in the printed transcript: the truncated ephemeral
// vendor address that rides in a check's DETAIL (random per run by design). Mirrors pilot.result.test.js.
function maskVendorDetails(transcript) {
  return transcript.replace(/vendor 0x[0-9a-fA-F]{8}…/g, "vendor 0x<EPHEMERAL>…");
}

// Run the INDEPENDENT verifier as a REAL child process (the exact thing a counterparty runs). Returns
// { code, json } — json parsed from --json stdout (null if unparseable). This is the strongest possible
// proof: no producer code on the verify path, a separate process, the real exit code.
function runVerifyVhProcess(args) {
  const r = spawnSync("node", [VERIFY_VH, "--json", ...args], {
    cwd: REPO,
    encoding: "utf8",
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch (_) {
    json = null;
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

// A tiny in-process io capture for the evidence/verify-vh module entrypoints.
function cap() {
  const o = [];
  const e = [];
  return {
    write: (s) => o.push(s),
    writeErr: (s) => e.push(s),
    out: () => o.join(""),
    err: () => e.join(""),
  };
}

describe("pilot/run-pilot.js T-53.2: --certificate seals the pilot result into a verifiable packet", function () {
  this.timeout(120000);

  let tmpDirs;
  let cwdBefore;
  beforeEach(function () {
    tmpDirs = [];
    cwdBefore = fs.readdirSync(process.cwd()).sort();
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    // FILESYSTEM HYGIENE: nothing leaked into the working tree.
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-pilot-cert-test-"));
    tmpDirs.push(d);
    return d;
  }

  // Run the pilot once in a throwaway workspace and return its canonical result record. stdout silenced.
  async function runPilotQuiet() {
    const ws = mkTmp();
    const orig = process.stdout.write;
    process.stdout.write = () => true;
    let result;
    try {
      result = await pilot.runPilot(ws);
    } finally {
      process.stdout.write = orig;
    }
    return result;
  }

  // -----------------------------------------------------------------------------------------------
  // 1. UNSIGNED certificate: written, INDEPENDENTLY accepted (root re-derived), tamper rejected + localized.
  // -----------------------------------------------------------------------------------------------
  it("with --certificate writes a *.vhevidence.json the INDEPENDENT verify-vh ACCEPTS (root re-derived from bytes)", async function () {
    const result = await runPilotQuiet();
    const certDir = mkTmp();
    const certPath = path.join(certDir, "out.vhevidence.json");

    const info = await pilot.writeCertificate(result, certPath, {});

    // The packet exists, is a *.vhevidence.json, and is a bare (unsigned) evidence seal.
    expect(fs.existsSync(certPath)).to.equal(true);
    expect(certPath).to.match(/\.vhevidence\.json$/);
    const packet = JSON.parse(fs.readFileSync(certPath, "utf8"));
    expect(packet.kind).to.equal(evidence.SEAL_KIND);
    expect(info.signed).to.equal(false);

    // The sealed result bytes ship alongside the certificate, under its dedicated files dir.
    expect(fs.existsSync(info.siblingResult)).to.equal(true);
    expect(path.basename(info.siblingResult)).to.equal(pilot.CERTIFICATE_RESULT_NAME);

    // The certificate seals the EXACT canonical result record (so the packet IS over THIS run).
    expect(fs.readFileSync(info.siblingResult, "utf8")).to.equal(
      pilot.serializeResultForCertificate(result)
    );

    // The INDEPENDENT verifier (REAL child process) ACCEPTS (exit 0) and re-derives the root from the bytes.
    const ok = runVerifyVhProcess(["--dir", info.filesDir, certPath]);
    expect(ok.code, ok.stderr).to.equal(0);
    expect(ok.json).to.be.an("object");
    expect(ok.json.verdict).to.equal("OK");
    expect(ok.json.rootMatches).to.equal(true);
    expect(ok.json.payloadKind).to.equal(verifyVh.KINDS.EVIDENCE_SEAL);
  });

  it("a ONE-BYTE tamper of the sealed bytes makes the INDEPENDENT verify-vh REJECT (exit 3) and LOCALIZE it", async function () {
    const result = await runPilotQuiet();
    const certDir = mkTmp();
    const certPath = path.join(certDir, "out.vhevidence.json");
    const info = await pilot.writeCertificate(result, certPath, {});

    // Sanity: it ACCEPTS clean first (so the REJECT below is caused by the tamper, not a broken setup).
    const clean = runVerifyVhProcess(["--dir", info.filesDir, certPath]);
    expect(clean.code, clean.stderr).to.equal(0);

    // Flip exactly ONE byte of the sealed result file.
    const before = fs.readFileSync(info.siblingResult);
    const mutated = Buffer.from(before);
    mutated[0] = mutated[0] ^ 0x01;
    fs.writeFileSync(info.siblingResult, mutated);

    const bad = runVerifyVhProcess(["--dir", info.filesDir, certPath]);
    expect(bad.code).to.equal(3); // verify-vh EXIT.REJECTED
    expect(bad.json).to.be.an("object");
    expect(bad.json.verdict).to.equal("REJECTED");
    // The tamper localizes to EXACTLY the one sealed file.
    const changed = (bad.json.changed || []).map((c) => c.relPath);
    expect(changed).to.deep.equal([pilot.CERTIFICATE_RESULT_NAME]);
  });

  it("a one-byte tamper is NEVER a false ACCEPT across many random byte positions (real verifier)", async function () {
    const result = await runPilotQuiet();
    const certDir = mkTmp();
    const certPath = path.join(certDir, "out.vhevidence.json");
    const info = await pilot.writeCertificate(result, certPath, {});
    const original = fs.readFileSync(info.siblingResult);

    // Drive the in-process REAL verifier (fast) over several distinct single-byte mutations: EVERY one must
    // REJECT (exit 3). If any returned ACCEPT, the seal would be worthless — this guards the core claim.
    const positions = [0, 1, 5, Math.floor(original.length / 2), original.length - 1];
    for (const pos of positions) {
      const mutated = Buffer.from(original);
      mutated[pos] = mutated[pos] ^ 0xff;
      fs.writeFileSync(info.siblingResult, mutated);
      const io = cap();
      const code = verifyVh.run(["--json", "--dir", info.filesDir, certPath], io);
      let parsed = null;
      try {
        parsed = JSON.parse(io.out());
      } catch (_) {
        parsed = null;
      }
      expect(code, `byte ${pos} should REJECT`).to.equal(verifyVh.EXIT.REJECTED);
      expect(parsed && parsed.verdict).to.equal("REJECTED");
    }
    // Restore the clean bytes and confirm it ACCEPTS again (the verifier isn't simply always-reject).
    fs.writeFileSync(info.siblingResult, original);
    const io = cap();
    const code = verifyVh.run(["--json", "--dir", info.filesDir, certPath], io);
    expect(code).to.equal(verifyVh.EXIT.OK);
  });

  // -----------------------------------------------------------------------------------------------
  // 2. NO --certificate: nothing written; stdout + exit code byte-for-byte the baseline.
  // -----------------------------------------------------------------------------------------------
  it("with NO --certificate: NO file is written and stdout + exit code are byte-identical to a baseline run", function () {
    // Two real subprocess runs of the historical kit (no --certificate). After masking the random
    // ephemeral vendor detail, the transcripts must be byte-for-byte equal and exit 0.
    const run = () => {
      const ws = mkTmp();
      const env = Object.assign({}, process.env, { PILOT_OUT: ws, VH_RPC_URL: "", VH_TSA_URL: "" });
      const cwdSnapshot = fs.readdirSync(REPO).sort();
      // execFileSync throws on non-zero exit; a clean return proves exit 0.
      const stdout = execFileSync("node", [RUN_JS], { cwd: REPO, env, encoding: "utf8" });
      // No certificate artifact appeared anywhere in the repo tree.
      expect(fs.readdirSync(REPO).sort()).to.deep.equal(cwdSnapshot);
      return stdout;
    };
    const t1 = maskVendorDetails(run());
    const t2 = maskVendorDetails(run());
    expect(t1).to.equal(t2);

    // The baseline never mentions a certificate, and is all-PASS.
    expect(t1).to.not.include("PILOT CERTIFICATE");
    expect(t1).to.not.include(".vhevidence.json");
    expect(t1).to.match(/VERDICT: PASS — (\d+)\/\1 checks passed \(evidence \+ reconcile\)\.\n/);
    expect(t1).to.not.match(/\[FAIL\]/);
  });

  it("the run's runPilot transcript is UNCHANGED by --certificate (the certificate block is strictly appended)", function () {
    // A no-flag run and a --certificate run must be byte-identical up to AND INCLUDING the trailing blank
    // line after the VERDICT line — the certificate only APPENDS after that. Proven on real subprocesses.
    const noFlag = () => {
      const ws = mkTmp();
      const env = Object.assign({}, process.env, { PILOT_OUT: ws });
      return maskVendorDetails(execFileSync("node", [RUN_JS], { cwd: REPO, env, encoding: "utf8" }));
    };
    const withCert = () => {
      const ws = mkTmp();
      const certDir = mkTmp();
      const env = Object.assign({}, process.env, { PILOT_OUT: ws });
      const out = execFileSync(
        "node",
        [RUN_JS, "--certificate", path.join(certDir, "c.vhevidence.json")],
        { cwd: REPO, env, encoding: "utf8" }
      );
      return maskVendorDetails(out);
    };
    const a = noFlag();
    const b = withCert();

    // `a` is the FULL default transcript; `b` must START with exactly `a`, then add the certificate block.
    expect(b.startsWith(a), "cert run must be a strict superset (prefix) of the default transcript").to.equal(true);
    const appended = b.slice(a.length);
    expect(appended).to.include("PILOT CERTIFICATE");
    expect(appended).to.include("verifier/verify-vh.js");
  });

  it("the --certificate END-TO-END run actually writes a packet the verifier ACCEPTS (subprocess, no producer code on verify)", function () {
    // Run the REAL script with --certificate, then hand ONLY the written certificate + its files dir to the
    // INDEPENDENT verifier child process and confirm exit 0. This is the full buyer flow, end to end.
    const ws = mkTmp();
    const certDir = mkTmp();
    const certPath = path.join(certDir, "pilot.vhevidence.json");
    const env = Object.assign({}, process.env, { PILOT_OUT: ws });
    const code = spawnSync("node", [RUN_JS, "--certificate", certPath], {
      cwd: REPO,
      env,
      encoding: "utf8",
    }).status;
    expect(code).to.equal(0);
    expect(fs.existsSync(certPath)).to.equal(true);
    const filesDir = certPath.replace(/\.vhevidence\.json$/, "") + ".files";
    expect(fs.existsSync(path.join(filesDir, pilot.CERTIFICATE_RESULT_NAME))).to.equal(true);

    const ok = runVerifyVhProcess(["--dir", filesDir, certPath]);
    expect(ok.code, ok.stderr).to.equal(0);
    expect(ok.json.verdict).to.equal("OK");
    expect(ok.json.rootMatches).to.equal(true);
  });

  // -----------------------------------------------------------------------------------------------
  // 3. OPTIONAL --sign: signed certificate round-trips through verify-signed with an EPHEMERAL key.
  // -----------------------------------------------------------------------------------------------
  it("--sign --vendor <ephemeral> produces a SIGNED certificate verify-signed ACCEPTS pinned to that vendor", async function () {
    const result = await runPilotQuiet();
    const certDir = mkTmp();
    const certPath = path.join(certDir, "signed.vhevidence.json");

    // An EPHEMERAL operator key — created, used, discarded. The loop NEVER holds a real key.
    const op = Wallet.createRandom();
    const KEY_ENV = "VH_PILOT_CERT_TEST_KEY";
    const PREV = process.env[KEY_ENV];
    process.env[KEY_ENV] = op.privateKey;
    let info;
    try {
      info = await pilot.writeCertificate(result, certPath, {
        sign: true,
        keyEnv: KEY_ENV,
        vendor: op.address,
      });
    } finally {
      if (PREV === undefined) delete process.env[KEY_ENV];
      else process.env[KEY_ENV] = PREV;
    }

    // The certificate is a SIGNED evidence packet whose recovered signer is the ephemeral operator key.
    const packet = JSON.parse(fs.readFileSync(certPath, "utf8"));
    expect(packet.kind).to.equal(evidence.SIGNED_SEAL_KIND);
    expect(info.signed).to.equal(true);
    expect(String(info.signer).toLowerCase()).to.equal(op.address.toLowerCase());

    // `vh evidence verify-signed` ACCEPTS (exit 0), pinned to the ephemeral vendor (--signer) and binding
    // the sealed bytes (--dir). This is the recipient-side acceptance the criterion names.
    {
      const io = cap();
      const code = evidence.runEvidenceVerifySigned(
        { signed: certPath, dir: info.filesDir, signer: op.address, json: true },
        io
      );
      const parsed = JSON.parse(io.out());
      expect(code, io.err()).to.equal(evidence.EXIT.OK);
      expect(parsed.accepted).to.equal(true);
      expect(String(parsed.recoveredSigner).toLowerCase()).to.equal(op.address.toLowerCase());
      expect(parsed.failedChecks || []).to.deep.equal([]);
    }

    // The INDEPENDENT verify-vh (child process) ALSO ACCEPTS, pinning the operator as --vendor.
    const ok = runVerifyVhProcess(["--dir", info.filesDir, "--vendor", op.address, certPath]);
    expect(ok.code, ok.stderr).to.equal(0);
    expect(ok.json.verdict).to.equal("OK");
    expect(ok.json.signed).to.equal(true);
    expect(ok.json.signerMatchesVendor).to.equal(true);
    expect(ok.json.rootMatches).to.equal(true);

    // And a one-byte tamper still REJECTS the signed certificate (signature can't rescue mutated bytes).
    const before = fs.readFileSync(info.siblingResult);
    const mutated = Buffer.from(before);
    mutated[0] = mutated[0] ^ 0x01;
    fs.writeFileSync(info.siblingResult, mutated);
    const bad = runVerifyVhProcess(["--dir", info.filesDir, "--vendor", op.address, certPath]);
    expect(bad.code).to.equal(3);
    expect(bad.json.verdict).to.equal("REJECTED");
  });

  it("--sign with NO key supplied mints an EPHEMERAL operator key and still produces a verifiable signed certificate", async function () {
    // No --key-env/--key-file and no --vendor: the kit mints its own ephemeral operator key, signs, and
    // pins it. The signed certificate is still independently verifiable, pinned to the minted signer.
    const result = await runPilotQuiet();
    const certDir = mkTmp();
    const certPath = path.join(certDir, "selfsigned.vhevidence.json");

    const info = await pilot.writeCertificate(result, certPath, { sign: true });
    expect(info.signed).to.equal(true);
    expect(info.signer).to.match(/^0x[0-9a-fA-F]{40}$/);

    // No key material lingered in the environment.
    expect(process.env.PILOT_CERT_OP_KEY).to.equal(undefined);

    const ok = runVerifyVhProcess(["--dir", info.filesDir, "--vendor", info.signer, certPath]);
    expect(ok.code, ok.stderr).to.equal(0);
    expect(ok.json.verdict).to.equal("OK");
    expect(ok.json.signerMatchesVendor).to.equal(true);
  });

  it("a malformed --vendor on a --sign run is a clean usage error (no half-written certificate)", async function () {
    const result = await runPilotQuiet();
    const certDir = mkTmp();
    const certPath = path.join(certDir, "bad.vhevidence.json");
    let threw = null;
    try {
      await pilot.writeCertificate(result, certPath, { sign: true, vendor: "not-an-address" });
    } catch (e) {
      threw = e;
    }
    expect(threw).to.be.an.instanceof(pilot.PilotInputError);
    expect(threw.userError).to.equal(true);
    // Nothing was written.
    expect(fs.existsSync(certPath)).to.equal(false);
  });

  it("a --vendor that does NOT match the signing key is REJECTED (never silently re-pinned to the operator)", async function () {
    // HONESTY GUARD: --vendor is documented as the address PINNED as the certificate's signer. The kit signs
    // with the OPERATOR key, so a --vendor naming a DIFFERENT address can never be honored. It MUST fail
    // loud — never sign with the operator and silently drop the user's pin (which would hand them a
    // certificate vouching for an identity they did not request). We sign with key-for-0xAAA but ask to pin
    // a DIFFERENT well-formed 0xBBB, and assert a clean PilotInputError that names BOTH addresses.
    const result = await runPilotQuiet();
    const certDir = mkTmp();
    const certPath = path.join(certDir, "mismatch.vhevidence.json");

    const op = Wallet.createRandom(); // signs as op.address (the would-be operator)
    const other = Wallet.createRandom(); // a DIFFERENT, well-formed address the user asks to pin
    expect(other.address.toLowerCase()).to.not.equal(op.address.toLowerCase());

    const KEY_ENV = "VH_PILOT_CERT_MISMATCH_KEY";
    const PREV = process.env[KEY_ENV];
    process.env[KEY_ENV] = op.privateKey;
    let threw = null;
    try {
      await pilot.writeCertificate(result, certPath, {
        sign: true,
        keyEnv: KEY_ENV,
        vendor: other.address,
      });
    } catch (e) {
      threw = e;
    } finally {
      if (PREV === undefined) delete process.env[KEY_ENV];
      else process.env[KEY_ENV] = PREV;
    }

    expect(threw, "supplying --vendor != signer must throw, never silently re-pin").to.be.an.instanceof(
      pilot.PilotInputError
    );
    expect(threw.userError).to.equal(true);
    // The message names BOTH the requested pin and the actual signer (a "you asked X but this key signs Y").
    // Addresses are compared case-insensitively (the recovered signer is stored lowercased).
    const msgLower = threw.message.toLowerCase();
    expect(msgLower).to.include(other.address.toLowerCase());
    expect(msgLower).to.include(op.address.toLowerCase());
    // No half-written certificate vouching for the WRONG identity was left behind.
    expect(fs.existsSync(certPath)).to.equal(false);
  });

  it("--sign --vendor EQUAL to the signing key is HONORED (the matching-pin happy path)", async function () {
    // The mirror of the mismatch case: when --vendor EQUALS the operator key's address, the pin is honored
    // and the signed certificate verifies pinned to that vendor. (Distinct from the section-3 case above in
    // that it explicitly contrasts the rejected mismatch — same address ⇒ accept, different ⇒ reject.)
    const result = await runPilotQuiet();
    const certDir = mkTmp();
    const certPath = path.join(certDir, "match.vhevidence.json");

    const op = Wallet.createRandom();
    const KEY_ENV = "VH_PILOT_CERT_MATCH_KEY";
    const PREV = process.env[KEY_ENV];
    process.env[KEY_ENV] = op.privateKey;
    let info;
    try {
      info = await pilot.writeCertificate(result, certPath, {
        sign: true,
        keyEnv: KEY_ENV,
        vendor: op.address, // EQUAL to the signer — honored
      });
    } finally {
      if (PREV === undefined) delete process.env[KEY_ENV];
      else process.env[KEY_ENV] = PREV;
    }

    expect(info.signed).to.equal(true);
    expect(String(info.signer).toLowerCase()).to.equal(op.address.toLowerCase());
    const ok = runVerifyVhProcess(["--dir", info.filesDir, "--vendor", op.address, certPath]);
    expect(ok.code, ok.stderr).to.equal(0);
    expect(ok.json.signerMatchesVendor).to.equal(true);
  });

  // -----------------------------------------------------------------------------------------------
  // 4. The certificate is DETERMINISTIC + key/path-free in its sealed bytes (the unsigned seal is pure).
  // -----------------------------------------------------------------------------------------------
  it("the UNSIGNED certificate's sealed bytes + root are byte-identical across runs (deterministic)", async function () {
    const result = await runPilotQuiet();
    const certA = path.join(mkTmp(), "a.vhevidence.json");
    const certB = path.join(mkTmp(), "b.vhevidence.json");
    const a = await pilot.writeCertificate(result, certA, {});
    const b = await pilot.writeCertificate(result, certB, {});

    // The sealed result bytes are identical, and the re-derived root matches.
    expect(fs.readFileSync(a.siblingResult, "utf8")).to.equal(fs.readFileSync(b.siblingResult, "utf8"));
    expect(a.root).to.equal(b.root);
    // No absolute/temp path or key leaked into the sealed result bytes.
    const bytes = fs.readFileSync(a.siblingResult, "utf8");
    expect(bytes).to.not.match(/\/tmp\//);
    expect(bytes).to.not.match(/0x[0-9a-fA-F]{40}/);
  });
});

"use strict";

// test/vendor-provenance.test.js — T-73.5: the vendor SELF-PROVENANCE packet builder
// (scripts/vendor-provenance.cjs), end-to-end with an EPHEMERAL throwaway key.
//
// PROVES (each its own test below):
//   (1) the script runs fully OFFLINE with an ephemeral key and emits BOTH artifacts — the
//       UNSIGNED `vh.evidence-seal` packet and the SIGNED container — over the SAME root
//       (byte-for-byte: the unsigned seal IS the signed container's embedded attestation);
//   (2) the identity statement names the vendor address DERIVED from the caller-supplied key,
//       the package name/version from package.json, the git commit packed, and both tarball
//       digests — scoped EXPLICITLY to the locally packed tarball, never the registry's;
//   (3) `vh evidence verify` exits 0 on BOTH artifacts and `vh evidence verify-signed
//       --signer <ephemeral>` ACCEPTs; a one-byte flip in a sealed file -> exit 3 (and a
//       tampered signature -> exit 3);
//   (4) the EMITTED anchor command, executed through cli/vh.js with ONLY the RPC swapped to an
//       unreachable loopback URL, fails with the NETWORK exit 1 — proving the copy-paste
//       survives flag parsing (exit 2) and the closed-table validation (exit 3) on OUR side;
//       anchoring the SIGNED container instead is the unknown-kind exit 3;
//   (5) the human-step block is printed, numbered, and the script never anchored, never wrote a
//       receipt, and never leaked the private key into any output or emitted file.
//
// The ONLY endpoint any spawned process ever dials is the intentionally UNREACHABLE loopback
// URL substituted by THIS test (127.0.0.1:9 — connection refused); the script itself is offline.

const { expect } = require("chai");
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Wallet } = require("ethers");

const { hashBytes } = require("../cli/hash");

const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "vendor-provenance.cjs");
const VH = path.join(REPO, "cli", "vh.js");
const NODE = process.execPath;

// The EPHEMERAL throwaway key: generated in-test, funds nothing, signs only this rehearsal.
const KEY_ENV = "VH_VENDOR_PROVENANCE_TEST_KEY";
const wallet = Wallet.createRandom();
const ENV = { ...process.env, [KEY_ENV]: wallet.privateKey };

// An unreachable loopback endpoint (nothing listens on the discard port) — the ONLY "network"
// any process in this file ever attempts.
const UNREACHABLE_RPC = "http://127.0.0.1:9/";

const LIVE_CONTRACT = "0x77d8eF881D5aeEda64788968D13f9146fE1A609B";
const LIVE_RPC = "https://polygon-bor-rpc.publicnode.com";

let tmpDirs = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function runVh(args) {
  return spawnSync(NODE, [VH, ...args], { cwd: REPO, env: ENV, encoding: "utf8" });
}

/** Recursively copy a small dir (payload fixtures only). */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

describe("T-73.5 vendor self-provenance packet builder (scripts/vendor-provenance.cjs)", function () {
  this.timeout(300000);

  let outDir;
  let res; // the script's spawnSync result
  let unsignedPath, signedPath, licensePath, payloadDir, receiptPath;
  let anchorTokens; // the emitted anchor command, tokenized ("vh", "anchor-artifact", ...)

  before(function () {
    outDir = path.join(tmp("vh-vendor-prov-"), "packet");
    res = spawnSync(NODE, [SCRIPT, "--key-env", KEY_ENV, "--out", outDir], {
      cwd: REPO,
      env: ENV,
      encoding: "utf8",
    });
    unsignedPath = path.join(outDir, "vendor-provenance.vhevidence.json");
    signedPath = path.join(outDir, "vendor-provenance.signed.vhevidence.json");
    licensePath = path.join(outDir, "vendor-license.vhevidence-license.json");
    payloadDir = path.join(outDir, "payload");
    receiptPath = path.join(outDir, "vendor-provenance.anchored-receipt.json");
    const cmdLine = (res.stdout || "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("vh anchor-artifact "));
    anchorTokens = cmdLine ? cmdLine.split(/\s+/) : null;
  });

  after(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs = [];
  });

  it("runs end-to-end offline with an ephemeral key (exit 0) and emits BOTH artifacts over the SAME root", function () {
    expect(res.status, `script must exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`).to.equal(0);
    for (const f of [unsignedPath, signedPath, licensePath, path.join(payloadDir, "IDENTITY.json")]) {
      expect(fs.existsSync(f), `${f} must exist`).to.equal(true);
    }
    const unsignedBytes = fs.readFileSync(unsignedPath, "utf8");
    const unsigned = JSON.parse(unsignedBytes);
    const signed = JSON.parse(fs.readFileSync(signedPath, "utf8"));
    // The UNSIGNED packet is the ONE evidence kind in anchor-artifact's closed table; the signed
    // container is a DIFFERENT kind wrapping the EXACT same canonical bytes (same root).
    expect(unsigned.kind).to.equal("vh.evidence-seal");
    expect(signed.kind).to.equal("vh.evidence-seal-signed");
    expect(signed.attestation).to.equal(unsignedBytes); // byte-for-byte: one root, one signed-over payload
    expect(JSON.parse(signed.attestation).root).to.equal(unsigned.root);
  });

  it("the identity statement names the derived vendor address, package name/version, git commit, and both digests — scoped to the LOCAL tarball only", function () {
    const identity = JSON.parse(fs.readFileSync(path.join(payloadDir, "IDENTITY.json"), "utf8"));
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));

    // vendor address DERIVED from the caller-supplied ephemeral key (canonical lowercase)
    expect(identity.vendorAddress).to.equal(wallet.address.toLowerCase());
    // package name/version from package.json
    expect(identity.package).to.deep.equal({ name: pkg.name, version: pkg.version });
    // the git commit packed
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout.trim();
    expect(identity.git.commit).to.equal(head);

    // BOTH digests, and they re-derive from the tarball actually sealed into the payload
    const tarName = identity.tarball.file;
    const tarBytes = fs.readFileSync(path.join(payloadDir, tarName));
    expect(identity.tarball.sha256).to.equal(crypto.createHash("sha256").update(tarBytes).digest("hex"));
    expect(identity.tarball.keccak256).to.equal(hashBytes(tarBytes));
    expect(identity.tarball.sha512Sri).to.equal(
      "sha512-" + crypto.createHash("sha512").update(tarBytes).digest("base64")
    );

    // The boundary language: digests of THIS locally packed tarball, NEVER asserted equal to the
    // registry's; registry equality is a named HUMAN/network step.
    expect(identity.tarball.scope).to.include("LOCALLY PACKED");
    expect(identity.tarball.scope).to.include("NOT asserted to equal the npm registry");
    expect(identity.statement).to.include("SELF-ASSERTED");
    expect(identity.statement).to.include("never WHEN");
  });

  it("`vh evidence verify` exits 0 on BOTH artifacts; `vh evidence verify-signed --signer <ephemeral>` ACCEPTs", function () {
    const vUnsigned = runVh(["evidence", "verify", unsignedPath, "--dir", payloadDir]);
    expect(vUnsigned.status, vUnsigned.stderr).to.equal(0);
    const vSigned = runVh(["evidence", "verify", signedPath, "--dir", payloadDir]);
    expect(vSigned.status, vSigned.stderr).to.equal(0);

    const vs = runVh([
      "evidence", "verify-signed", signedPath,
      "--dir", payloadDir,
      "--signer", wallet.address.toLowerCase(),
    ]);
    expect(vs.status, vs.stderr).to.equal(0);
    expect(vs.stdout).to.include("ACCEPTED");
  });

  it("a ONE-BYTE flip in a sealed file -> exit 3; a tampered signature -> exit 3", function () {
    // Flip one byte of the sealed tarball in a COPY of the payload dir: the seal must localize it.
    const tampered = path.join(tmp("vh-vendor-prov-tamper-"), "payload");
    copyDir(payloadDir, tampered);
    const identity = JSON.parse(fs.readFileSync(path.join(payloadDir, "IDENTITY.json"), "utf8"));
    const tarCopy = path.join(tampered, identity.tarball.file);
    const bytes = fs.readFileSync(tarCopy);
    bytes[0] ^= 0x01; // one bit of one byte
    fs.writeFileSync(tarCopy, bytes);
    const v = runVh(["evidence", "verify", unsignedPath, "--dir", tampered]);
    expect(v.status).to.equal(3);

    // Tamper the detached signature (one hex nibble): a clean REJECTED, never a silent pass.
    const signed = JSON.parse(fs.readFileSync(signedPath, "utf8"));
    const sig = signed.signature.signature;
    const last = sig.slice(-1) === "0" ? "1" : "0";
    signed.signature.signature = sig.slice(0, -1) + last;
    const forgedPath = path.join(tmp("vh-vendor-prov-forged-"), "forged.signed.vhevidence.json");
    fs.writeFileSync(forgedPath, JSON.stringify(signed) + "\n");
    const vs = runVh(["evidence", "verify-signed", forgedPath, "--dir", payloadDir, "--signer", wallet.address.toLowerCase()]);
    expect(vs.status).to.equal(3);
  });

  it("the EMITTED anchor command references the UNSIGNED seal + the live registry, verbatim", function () {
    expect(anchorTokens, `no "vh anchor-artifact" line in:\n${res.stdout}`).to.not.equal(null);
    expect(anchorTokens[0]).to.equal("vh");
    expect(anchorTokens[1]).to.equal("anchor-artifact");
    expect(anchorTokens[2]).to.equal(unsignedPath); // the UNSIGNED seal, never the signed container
    expect(anchorTokens[anchorTokens.indexOf("--contract") + 1]).to.equal(LIVE_CONTRACT);
    expect(anchorTokens[anchorTokens.indexOf("--rpc") + 1]).to.equal(LIVE_RPC);
    expect(anchorTokens[anchorTokens.indexOf("--key-env") + 1]).to.equal(KEY_ENV);
    expect(anchorTokens[anchorTokens.indexOf("--out") + 1]).to.equal(receiptPath);
    expect(anchorTokens).to.include("--i-understand-mainnet");
  });

  it("EXECUTING the emitted anchor command (ONLY the RPC swapped to an unreachable loopback) fails with the NETWORK exit 1 — flag parsing (2) and the closed table (3) both passed", function () {
    const tokens = anchorTokens.slice();
    tokens[tokens.indexOf("--rpc") + 1] = UNREACHABLE_RPC; // the ONLY edit
    const r = spawnSync(NODE, [VH, ...tokens.slice(1)], { cwd: REPO, env: ENV, encoding: "utf8" });
    // Exit 1 = the IO/network leg. A bad flag would have been exit 2 BEFORE any network use; an
    // artifact outside the closed table would have been exit 3 BEFORE any network use. The stderr
    // names the RPC step, proving the copy-paste survived everything on OUR side.
    expect(r.status, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).to.equal(1);
    expect(r.stderr).to.include("cannot reach the RPC endpoint");
  });

  it("anchoring the SIGNED container instead is the unknown-kind exit 3 (asserted, offline — before any network use)", function () {
    const tokens = anchorTokens.slice();
    tokens[2] = signedPath; // the signed container is NOT in anchor-artifact's closed kind table
    tokens[tokens.indexOf("--rpc") + 1] = UNREACHABLE_RPC; // never dial the live RPC in tests
    const r = spawnSync(NODE, [VH, ...tokens.slice(1)], { cwd: REPO, env: ENV, encoding: "utf8" });
    expect(r.status, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).to.equal(3);
    expect(r.stderr).to.include("unknown-kind");
  });

  it("prints the numbered HUMAN-STEP block; never anchors; never leaks the key into output or emitted files", function () {
    const out = res.stdout;
    expect(out).to.include("HUMAN STEPS");
    // The four numbered steps, in order, each with its load-bearing content.
    const i1 = out.indexOf("1. Confirm the LOCAL tarball digest");
    const i2 = out.indexOf("2. Re-run this script with the REAL vendor key");
    const i3 = out.indexOf("3. Anchor the UNSIGNED seal");
    const i4 = out.indexOf("4. Publish the vendor address");
    expect(i1).to.be.greaterThan(-1);
    expect(i2).to.be.greaterThan(i1);
    expect(i3).to.be.greaterThan(i2);
    expect(i4).to.be.greaterThan(i3);
    expect(out).to.include("npm view verifyhash dist.integrity"); // step 1: network, human-only
    expect(out).to.include("re-pack"); // step 1: the mismatch remedy
    expect(out).to.include("never claims\n     registry equality"); // the boundary, verbatim
    expect(out).to.include("--i-understand-mainnet"); // step 3: the exact anchor command
    expect(out).to.include("Publish the vendor address"); // step 4
    expect(out).to.include("pinning is only"); // pinning is only real once published

    // The script never anchored: no receipt was written.
    expect(fs.existsSync(receiptPath)).to.equal(false);

    // Key hygiene: the private key appears in NO output and NO emitted file.
    const keyHex = wallet.privateKey.slice(2).toLowerCase();
    expect((res.stdout + res.stderr).toLowerCase()).to.not.include(keyHex);
    for (const f of [unsignedPath, signedPath, licensePath, path.join(payloadDir, "IDENTITY.json")]) {
      expect(fs.readFileSync(f, "utf8").toLowerCase()).to.not.include(keyHex);
    }

    // The script source is node-core + spawned CLIs only: it never imports a network module.
    const src = fs.readFileSync(SCRIPT, "utf8");
    expect(src).to.not.match(/require\(["'](node:)?(https?|net|dns|tls|dgram)["']\)/);
  });
});

"use strict";

// T-47.1 — `cli/evidence.js › verifySignedSealAttestation`: the STRICT, PURE evidence signed-verify path
// that MIRRORS `cli/dataset.js › verifySignedAttestation` EXACTLY.
//
// What these prove (the acceptance criteria):
//   * It runs `coreAttestation.verifySignedAttestation` (via the existing `verifySignedSeal`) and returns
//     the SIBLING-PARITY verdict shape (the same fields the dataset sibling returns).
//   * Check 1 (signature recovers to the claimed signer) ALWAYS runs; with NO optional flags the two
//     optional checks are `null` (not requested) and never fail the gate.
//   * Check 2 (expected-signer pin) runs ONLY under `expectedSigner` (--signer): the RIGHT publisher PASSes,
//     a DIFFERENT one is a clean REJECTED naming the failed pin.
//   * The OPTIONAL `--dir` binding recomputes the canonical seal bytes from the holder's OWN directory and
//     ACCEPTS the matching dir / REJECTS a different one (binding-mismatch).
//   * A FORGED / TAMPERED / WRONG-KEY signature is REJECTED — NEVER a silent pass.
//   * It is OFFLINE / key-free / network-free, writes NOTHING, and mutates NEITHER the container NOR the dir
//     (the working tree / cwd is left CLEAN, pass or fail).
//
// Every signing key is an EPHEMERAL in-process Wallet.createRandom() (TEST-ONLY, never a real key / real
// funds). NO network, NO provider, NO key file anywhere — the verifier is purely offline.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Wallet, getAddress } = require("ethers");

const evidence = require("../cli/evidence");

describe("cli/evidence T-47.1: verifySignedSealAttestation (strict, PURE signed-verify)", function () {
  let tmpDirs;
  let cwdBefore;
  beforeEach(function () {
    tmpDirs = [];
    // Snapshot the working tree so we can assert NOTHING leaked into cwd (filesystem hygiene).
    cwdBefore = fs.readdirSync(process.cwd()).sort();
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    // FILESYSTEM HYGIENE: nothing this PURE path did touched the working tree (it writes nothing).
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-ev-vsig-"));
    tmpDirs.push(d);
    return d;
  }
  // Build a sealable directory with a few small files under a throwaway temp dir. Returns the dir abs path.
  function mkDir(files = { "a.txt": "AAA\n", "b.txt": "BBB\n", "sub/c.txt": "CCC\n" }) {
    const root = mkTmp();
    const d = path.join(root, "payload");
    fs.mkdirSync(d);
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(d, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return d;
  }
  // Build a GENUINE signed-seal container over `dir`, signed by an EPHEMERAL TEST-ONLY key. Returns
  // { dir, wallet, seal, container }. The container is the SAME validated object `vh evidence seal --sign`
  // produces in-memory (so this exercises the real signing path, not a hand-rolled envelope).
  async function signFixture(dir, wallet) {
    const w = wallet || Wallet.createRandom(); // EPHEMERAL, in-memory, TEST-ONLY — never persisted/funded.
    expect(w.privateKey).to.match(/^0x[0-9a-fA-F]{64}$/);
    const entries = evidence.loadDirEntries(path.resolve(dir));
    const seal = evidence.buildSeal(entries);
    const container = await evidence.signSealWith(seal, w);
    return { dir, wallet: w, seal, container };
  }

  it("ACCEPTS a genuine container; Check 1 runs, the two optional checks are null (not requested)", async function () {
    const dir = mkDir();
    const fx = await signFixture(dir);
    const r = evidence.verifySignedSealAttestation({ container: fx.container });
    expect(r.verdict).to.equal("ACCEPTED");
    expect(r.accepted).to.equal(true);
    // Check 1 ALWAYS runs and recovers exactly the signer.
    expect(r.checks.signatureMatchesSigner).to.equal(true);
    expect(r.recoveredSigner).to.equal(fx.wallet.address.toLowerCase());
    expect(r.claimedSigner).to.equal(fx.wallet.address.toLowerCase());
    expect(r.scheme).to.equal("eip191-personal-sign");
    // The two optional checks were NOT requested -> null, never fail the gate.
    expect(r.checks.signerMatchesExpected).to.equal(null);
    expect(r.checks.manifestBindsAttestation).to.equal(null);
    expect(r.expectedSigner).to.equal(null);
    expect(r.manifestChecked).to.equal(false);
    expect(r.failedChecks).to.deep.equal([]);
  });

  it("returns the SIBLING-PARITY verdict shape (same fields as the dataset verifySignedAttestation)", async function () {
    const fx = await signFixture(mkDir());
    const r = evidence.verifySignedSealAttestation({ container: fx.container });
    // The exact field set the dataset sibling documents — a future indexer/UI can depend on ONE shape.
    expect(r).to.have.all.keys(
      "verdict",
      "accepted",
      "recoveredSigner",
      "claimedSigner",
      "scheme",
      "checks",
      "expectedSigner",
      "manifestChecked",
      "failedChecks"
    );
    expect(r.checks).to.have.all.keys(
      "signatureMatchesSigner",
      "signerMatchesExpected",
      "manifestBindsAttestation"
    );
  });

  it("Check 2 runs ONLY under expectedSigner: the right publisher PASSes, a different one REJECTS", async function () {
    const fx = await signFixture(mkDir());
    // Right publisher (checksummed form accepted via getAddress -> the verifier normalizes) -> ACCEPTED.
    const ok = evidence.verifySignedSealAttestation({
      container: fx.container,
      expectedSigner: getAddress(fx.wallet.address), // EIP-55 checksummed
    });
    expect(ok.verdict).to.equal("ACCEPTED");
    expect(ok.checks.signerMatchesExpected).to.equal(true);
    expect(ok.expectedSigner).to.equal(fx.wallet.address.toLowerCase());

    // A DIFFERENT expected publisher -> REJECTED, naming the failed pin; the signature itself is still genuine.
    const other = Wallet.createRandom(); // TEST-ONLY key
    const bad = evidence.verifySignedSealAttestation({
      container: fx.container,
      expectedSigner: other.address,
    });
    expect(bad.verdict).to.equal("REJECTED");
    expect(bad.accepted).to.equal(false);
    expect(bad.checks.signerMatchesExpected).to.equal(false);
    expect(bad.checks.signatureMatchesSigner).to.equal(true); // the signature is genuine; only the PIN failed
    expect(bad.failedChecks).to.deep.equal(["signerMatchesExpected"]);
  });

  it("--dir BINDS the signature to the holder's directory: ACCEPTS the matching dir", async function () {
    const dir = mkDir();
    const fx = await signFixture(dir);
    const r = evidence.verifySignedSealAttestation({ container: fx.container, dir });
    expect(r.verdict).to.equal("ACCEPTED");
    expect(r.checks.manifestBindsAttestation).to.equal(true);
    expect(r.manifestChecked).to.equal(true);
  });

  it("--dir that DIFFERS from the signed payload REJECTS with a clean binding-mismatch", async function () {
    // Sign over dir A...
    const fx = await signFixture(mkDir({ "a.txt": "AAA\n", "b.txt": "BBB\n" }));
    // ...but the holder points --dir at a DIFFERENT directory (different content -> different seal bytes).
    const otherDir = mkDir({ "a.txt": "DIFFERENT\n", "b.txt": "BBB\n" });
    const r = evidence.verifySignedSealAttestation({ container: fx.container, dir: otherDir });
    expect(r.verdict).to.equal("REJECTED");
    expect(r.checks.manifestBindsAttestation).to.equal(false);
    // The signature is genuine; ONLY the dir binding failed.
    expect(r.checks.signatureMatchesSigner).to.equal(true);
    expect(r.failedChecks).to.deep.equal(["manifestBindsAttestation"]);
  });

  it("ALL checks together: a fully-pinned ACCEPT (signer pin + dir binding both PASS)", async function () {
    const dir = mkDir();
    const fx = await signFixture(dir);
    const r = evidence.verifySignedSealAttestation({
      container: fx.container,
      expectedSigner: fx.wallet.address,
      dir,
    });
    expect(r.verdict).to.equal("ACCEPTED");
    expect(r.checks).to.deep.equal({
      signatureMatchesSigner: true,
      signerMatchesExpected: true,
      manifestBindsAttestation: true,
    });
    expect(r.failedChecks).to.deep.equal([]);
  });

  it("a FORGED signature (wrong key signed the bytes) is REJECTED — never a silent pass", async function () {
    const dir = mkDir();
    // Build the seal, then hand-craft a container that CLAIMS `claimant` but was actually signed by `imposter`.
    const entries = evidence.loadDirEntries(path.resolve(dir));
    const seal = evidence.buildSeal(entries);
    const claimant = Wallet.createRandom(); // TEST-ONLY
    const imposter = Wallet.createRandom(); // TEST-ONLY
    // Sign with the imposter, then build a container that CLAIMS the claimant signed it.
    const imposterContainer = await evidence.signSealWith(seal, imposter);
    const forged = JSON.parse(JSON.stringify(imposterContainer));
    forged.signature.signer = claimant.address.toLowerCase(); // claims claimant; imposter actually signed
    // It must still be a structurally-valid container (so the rejection is a VERDICT, not a parse error).
    evidence.validateSignedSeal(forged);
    const r = evidence.verifySignedSealAttestation({ container: forged });
    expect(r.verdict).to.equal("REJECTED");
    expect(r.checks.signatureMatchesSigner).to.equal(false);
    expect(r.recoveredSigner).to.equal(imposter.address.toLowerCase());
    expect(r.claimedSigner).to.equal(claimant.address.toLowerCase());
    expect(r.failedChecks).to.include("signatureMatchesSigner");
  });

  it("a TAMPERED signature (a flipped byte) is REJECTED (recovered != claimed)", async function () {
    const fx = await signFixture(mkDir());
    const tampered = JSON.parse(JSON.stringify(fx.container));
    const sig = tampered.signature.signature;
    // Flip a middle hex char (stay lowercase + 65 bytes so the shape validator still accepts it).
    const idx = 50;
    const ch = sig[idx] === "a" ? "b" : "a";
    tampered.signature.signature = sig.slice(0, idx) + ch + sig.slice(idx + 1);
    evidence.validateSignedSeal(tampered); // structurally valid; the rejection is a verdict, not a parse error
    const r = evidence.verifySignedSealAttestation({ container: tampered });
    expect(r.verdict).to.equal("REJECTED");
    expect(r.checks.signatureMatchesSigner).to.equal(false);
    expect(r.recoveredSigner).to.not.equal(r.claimedSigner);
  });

  it("is OFFLINE/key-free and does NOT mutate the container (input is only READ)", async function () {
    const fx = await signFixture(mkDir());
    const before = JSON.stringify(fx.container);
    const r = evidence.verifySignedSealAttestation({
      container: fx.container,
      expectedSigner: fx.wallet.address,
      dir: fx.dir,
    });
    expect(r.verdict).to.equal("ACCEPTED");
    // The container object is unchanged (no key material, no mutation, no added fields).
    expect(JSON.stringify(fx.container)).to.equal(before);
  });

  it("the standing TRUST note reuses EVIDENCE_TRUST_NOTE verbatim + disavows a timestamp (P-3)", function () {
    expect(evidence.VERIFY_SIGNED_SEAL_TRUST_NOTE).to.contain(evidence.EVIDENCE_TRUST_NOTE);
    expect(evidence.VERIFY_SIGNED_SEAL_TRUST_NOTE).to.contain("does NOT by itself prove a trustworthy");
    expect(evidence.VERIFY_SIGNED_SEAL_TRUST_NOTE).to.contain("P-3");
  });

  it("rejects bad params (a typo never silently passes)", function () {
    expect(() => evidence.verifySignedSealAttestation()).to.throw(
      /verifySignedSealAttestation requires/
    );
    expect(() => evidence.verifySignedSealAttestation(null)).to.throw(
      /verifySignedSealAttestation requires/
    );
    expect(() => evidence.verifySignedSealAttestation([])).to.throw(
      /verifySignedSealAttestation requires/
    );
  });

  it("an unreadable --dir is a genuine error, never a silently-skipped binding", async function () {
    const fx = await signFixture(mkDir());
    expect(() =>
      evidence.verifySignedSealAttestation({ container: fx.container, dir: "/no/such/dir/at/all" })
    ).to.throw();
  });
});

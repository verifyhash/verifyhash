"use strict";

// T-47.2 — `vh evidence verify-signed <signed> [--dir <d>] [--signer <addr>] [--json]` (the CLI surface
// over the PURE `verifySignedSealAttestation` core, T-47.1) AND closing the SILENT CLAIM in
// `vh evidence verify`.
//
// What these prove (the acceptance criteria):
//   `vh evidence verify-signed`:
//     * runs OFFLINE / key-free / network-free (no provider, no key, no net) and WRITES NOTHING (the --dir
//       read is the only I/O) — the working tree / cwd is left CLEAN, pass or fail;
//     * LEADS with the trust caveat (the standing VERIFY_SIGNED_SEAL_TRUST_NOTE — reuses EVIDENCE_TRUST_NOTE
//       verbatim, disavows a timestamp/P-3, NOT a legal opinion);
//     * RECOVERS the signer (Check 1, ALWAYS), under --signer PINS it, under --dir BINDS the bytes, prints
//       per-check PASS/FAIL/[skip], and emits the structured verdict under --json;
//     * exits 0 ACCEPTED / 3 REJECTED / 2 usage / 1 IO;
//     * a FORGED / TAMPERED / WRONG-KEY signature, a WRONG --signer, and a WRONG --dir are each a clean
//       REJECTED (exit 3) — NEVER a silent pass.
//   `vh evidence verify` (the silent claim, CLOSED):
//     * on a GENUINE signed packet whose bytes match, it ACCEPTS the CONTENT but labels the signer
//       UNVERIFIED-for-pinning and POINTS at `verify-signed` (it never reports the claimed signer as trusted);
//     * on a FORGED signed packet it REJECTS (exit 3) even when the content matches — the unbacked `signer`
//       label alone is sufficient to reject;
//     * the existing seal/diff behavior + exit codes are UNCHANGED (a bare unsigned packet still verifies
//       exactly as before).
//
// Every signing key is an EPHEMERAL in-process Wallet.createRandom() (TEST-ONLY, never a real key / real
// funds). Signed containers are written to disk via the PUBLIC build+serialize path (the SAME bytes
// `vh evidence seal --sign` emits), so the test exercises the genuine artifact, not a hand-rolled envelope.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Wallet, getAddress } = require("ethers");

const evidence = require("../cli/evidence");
const coreAttestation = require("../cli/core/attestation");

function capture() {
  const out = [];
  const err = [];
  return {
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

describe("cli/evidence T-47.2: `vh evidence verify-signed` + close the silent claim in `verify`", function () {
  let tmpDirs;
  let cwdBefore;
  beforeEach(function () {
    tmpDirs = [];
    // Snapshot the working tree so we can assert NOTHING leaked into cwd (filesystem hygiene).
    cwdBefore = fs.readdirSync(process.cwd()).sort();
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    // FILESYSTEM HYGIENE: nothing the verify/verify-signed paths did leaked into the working tree.
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-ev-vsig-cli-"));
    tmpDirs.push(d);
    return d;
  }
  // Build a sealable directory with a few small files under a throwaway temp dir. Returns { root, dir }.
  function mkDir(files = { "a.txt": "AAA\n", "b.txt": "BBB\n", "sub/c.txt": "CCC\n" }) {
    const root = mkTmp();
    const dir = path.join(root, "payload");
    fs.mkdirSync(dir);
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(dir, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return { root, dir };
  }
  // Write a GENUINE signed-seal container over `dir` (signed by an EPHEMERAL TEST-ONLY key) to a file under
  // `root`. Returns { wallet, packetPath, container }. Uses the PUBLIC build+serialize path (the SAME bytes
  // `vh evidence seal --sign` emits), so the on-disk artifact is the real one.
  async function writeSignedPacket(root, dir, wallet) {
    const w = wallet || Wallet.createRandom(); // EPHEMERAL, in-memory, TEST-ONLY — never persisted/funded.
    const entries = evidence.loadDirEntries(path.resolve(dir));
    const seal = evidence.buildSeal(entries);
    const container = await evidence.signSealWith(seal, w);
    const text = coreAttestation.serializeSignedAttestation(container, evidence.SIGNED_SEAL_CFG);
    const packetPath = path.join(root, "signed.vhevidence.json");
    fs.writeFileSync(packetPath, text);
    return { wallet: w, packetPath, container };
  }
  // Write a BARE (unsigned) seal packet over `dir`. Returns the packet path.
  function writeBarePacket(root, dir) {
    const entries = evidence.loadDirEntries(path.resolve(dir));
    const seal = evidence.buildSeal(entries);
    const packetPath = path.join(root, "bare.vhevidence.json");
    fs.writeFileSync(packetPath, evidence.serializeSeal(seal));
    return packetPath;
  }

  // =====================================================================================================
  // `vh evidence verify-signed`
  // =====================================================================================================

  it("ACCEPTS a genuine packet: exit 0, leads with the trust caveat, Check 1 PASS + the two optional checks [skip]", async function () {
    const { root, dir } = mkDir();
    const fx = await writeSignedPacket(root, dir);
    const io = capture();
    const code = await evidence.cmdEvidence(["verify-signed", fx.packetPath], io);

    expect(code).to.equal(evidence.EXIT.OK);
    const out = io.out();
    // LEADS with the trust caveat (reuses EVIDENCE_TRUST_NOTE verbatim + disavows a timestamp/P-3).
    expect(out).to.match(/^TRUST: /);
    expect(out).to.contain(evidence.EVIDENCE_TRUST_NOTE);
    expect(out).to.contain("P-3");
    // Verdict + the recovered signer (the REAL signer, not the merely-claimed label).
    expect(out).to.contain("verify-signed:    ACCEPTED");
    expect(out).to.contain(`recovered signer: ${fx.wallet.address.toLowerCase()}`);
    // Check 1 PASS; the two optional checks were not requested -> [skip].
    expect(out).to.contain("[PASS] signature recovers to the claimed signer");
    expect(out).to.contain("[skip] expected-signer pin: not requested");
    expect(out).to.contain("[skip] directory binding: not requested");
    expect(out).to.contain("ACCEPTED: every requested check passed.");
  });

  it("--json carries the structured verdict (sibling-parity shape + the trust note)", async function () {
    const { root, dir } = mkDir();
    const fx = await writeSignedPacket(root, dir);
    const io = capture();
    const code = await evidence.cmdEvidence(["verify-signed", fx.packetPath, "--json"], io);
    expect(code).to.equal(evidence.EXIT.OK);
    const j = JSON.parse(io.out());
    expect(j.verdict).to.equal("ACCEPTED");
    expect(j.accepted).to.equal(true);
    expect(j.recoveredSigner).to.equal(fx.wallet.address.toLowerCase());
    expect(j.claimedSigner).to.equal(fx.wallet.address.toLowerCase());
    expect(j.scheme).to.equal("eip191-personal-sign");
    expect(j.checks).to.deep.equal({
      signatureMatchesSigner: true,
      signerMatchesExpected: null,
      manifestBindsAttestation: null,
    });
    expect(j.failedChecks).to.deep.equal([]);
    expect(j.note).to.equal(evidence.VERIFY_SIGNED_SEAL_TRUST_NOTE);
    expect(j.signed).to.equal(fx.packetPath);
    expect(j.dir).to.equal(null);
  });

  it("--signer PINS the signer: the RIGHT signer (EIP-55) PASSes, a DIFFERENT one is a clean REJECTED (exit 3)", async function () {
    const { root, dir } = mkDir();
    const fx = await writeSignedPacket(root, dir);

    // Right signer, passed checksummed -> ACCEPTED, Check 2 PASS.
    const okIo = capture();
    const okCode = await evidence.cmdEvidence(
      ["verify-signed", fx.packetPath, "--signer", getAddress(fx.wallet.address), "--json"],
      okIo
    );
    expect(okCode).to.equal(evidence.EXIT.OK);
    const okJ = JSON.parse(okIo.out());
    expect(okJ.verdict).to.equal("ACCEPTED");
    expect(okJ.checks.signerMatchesExpected).to.equal(true);
    expect(okJ.expectedSigner).to.equal(fx.wallet.address.toLowerCase());

    // A DIFFERENT expected signer -> REJECTED (exit 3), naming the failed pin; the signature is still genuine.
    const other = Wallet.createRandom(); // TEST-ONLY
    const badIo = capture();
    const badCode = await evidence.cmdEvidence(
      ["verify-signed", fx.packetPath, "--signer", other.address, "--json"],
      badIo
    );
    expect(badCode).to.equal(evidence.EXIT.FAIL);
    const badJ = JSON.parse(badIo.out());
    expect(badJ.verdict).to.equal("REJECTED");
    expect(badJ.checks.signatureMatchesSigner).to.equal(true); // genuine; only the PIN failed
    expect(badJ.checks.signerMatchesExpected).to.equal(false);
    expect(badJ.failedChecks).to.deep.equal(["signerMatchesExpected"]);
  });

  it("--dir BINDS the bytes: the MATCHING dir ACCEPTS, a DIFFERENT dir is a clean binding-mismatch REJECTED (exit 3)", async function () {
    const { root, dir } = mkDir({ "a.txt": "AAA\n", "b.txt": "BBB\n" });
    const fx = await writeSignedPacket(root, dir);

    // Matching dir -> ACCEPTED, Check 3 PASS.
    const okIo = capture();
    const okCode = await evidence.cmdEvidence(["verify-signed", fx.packetPath, "--dir", dir, "--json"], okIo);
    expect(okCode).to.equal(evidence.EXIT.OK);
    const okJ = JSON.parse(okIo.out());
    expect(okJ.verdict).to.equal("ACCEPTED");
    expect(okJ.checks.manifestBindsAttestation).to.equal(true);
    expect(okJ.manifestChecked).to.equal(true);
    expect(okJ.dir).to.equal(path.resolve(dir));

    // A DIFFERENT dir (different content) -> REJECTED, binding-mismatch; the signature is still genuine.
    const otherDir = mkDir({ "a.txt": "DIFFERENT\n", "b.txt": "BBB\n" }).dir;
    const badIo = capture();
    const badCode = await evidence.cmdEvidence(
      ["verify-signed", fx.packetPath, "--dir", otherDir, "--json"],
      badIo
    );
    expect(badCode).to.equal(evidence.EXIT.FAIL);
    const badJ = JSON.parse(badIo.out());
    expect(badJ.verdict).to.equal("REJECTED");
    expect(badJ.checks.signatureMatchesSigner).to.equal(true);
    expect(badJ.checks.manifestBindsAttestation).to.equal(false);
    expect(badJ.failedChecks).to.deep.equal(["manifestBindsAttestation"]);
    // The HUMAN path NAMES the binding-mismatch.
    const hio = capture();
    await evidence.cmdEvidence(["verify-signed", fx.packetPath, "--dir", otherDir], hio);
    expect(hio.out()).to.contain("binding-mismatch");
  });

  it("a fully-pinned run (--signer + --dir both PASS) is ACCEPTED with all three checks true", async function () {
    const { root, dir } = mkDir();
    const fx = await writeSignedPacket(root, dir);
    const io = capture();
    const code = await evidence.cmdEvidence(
      ["verify-signed", fx.packetPath, "--signer", fx.wallet.address, "--dir", dir, "--json"],
      io
    );
    expect(code).to.equal(evidence.EXIT.OK);
    const j = JSON.parse(io.out());
    expect(j.checks).to.deep.equal({
      signatureMatchesSigner: true,
      signerMatchesExpected: true,
      manifestBindsAttestation: true,
    });
    expect(j.failedChecks).to.deep.equal([]);
  });

  it("a FORGED signature (claims a signer it did not sign for) is REJECTED (exit 3) — never a silent pass", async function () {
    const { root, dir } = mkDir();
    const entries = evidence.loadDirEntries(path.resolve(dir));
    const seal = evidence.buildSeal(entries);
    const claimant = Wallet.createRandom(); // TEST-ONLY
    const imposter = Wallet.createRandom(); // TEST-ONLY
    const imposterContainer = await evidence.signSealWith(seal, imposter);
    const forged = JSON.parse(JSON.stringify(imposterContainer));
    forged.signature.signer = claimant.address.toLowerCase(); // claims claimant; imposter actually signed
    evidence.validateSignedSeal(forged); // structurally valid -> the rejection is a VERDICT, not a parse error
    const packetPath = path.join(root, "forged.vhevidence.json");
    fs.writeFileSync(packetPath, coreAttestation.serializeSignedAttestation(forged, evidence.SIGNED_SEAL_CFG));

    const io = capture();
    const code = await evidence.cmdEvidence(["verify-signed", packetPath, "--json"], io);
    expect(code).to.equal(evidence.EXIT.FAIL);
    const j = JSON.parse(io.out());
    expect(j.verdict).to.equal("REJECTED");
    expect(j.checks.signatureMatchesSigner).to.equal(false);
    expect(j.recoveredSigner).to.equal(imposter.address.toLowerCase());
    expect(j.claimedSigner).to.equal(claimant.address.toLowerCase());
    expect(j.failedChecks).to.include("signatureMatchesSigner");
    // The human path NAMES it a forgery.
    const hio = capture();
    await evidence.cmdEvidence(["verify-signed", packetPath], hio);
    expect(hio.out()).to.contain("forged-signature");
  });

  it("a malformed --signer is a USAGE error (exit 2), never a runtime throw", async function () {
    const { root, dir } = mkDir();
    const fx = await writeSignedPacket(root, dir);
    const io = capture();
    const code = await evidence.cmdEvidence(["verify-signed", fx.packetPath, "--signer", "0xnope"], io);
    expect(code).to.equal(evidence.EXIT.USAGE);
    expect(io.err()).to.match(/invalid --signer address/);
  });

  it("a missing <signed> path is IO (1); no <signed> at all is usage (2); an unknown flag is usage (2)", async function () {
    // Missing file -> IO.
    const io1 = capture();
    expect(await evidence.cmdEvidence(["verify-signed", "/no/such/packet.json"], io1)).to.equal(
      evidence.EXIT.IO
    );
    expect(io1.err()).to.match(/cannot read signed evidence packet/);
    // No positional -> usage.
    const io2 = capture();
    expect(await evidence.cmdEvidence(["verify-signed"], io2)).to.equal(evidence.EXIT.USAGE);
    // Unknown flag -> usage.
    const io3 = capture();
    expect(await evidence.cmdEvidence(["verify-signed", "x", "--bogus"], io3)).to.equal(
      evidence.EXIT.USAGE
    );
    // Extra positional -> usage.
    const io4 = capture();
    expect(await evidence.cmdEvidence(["verify-signed", "a", "b"], io4)).to.equal(evidence.EXIT.USAGE);
  });

  it("a BARE (unsigned) seal handed to verify-signed is an IO error pointing at `verify` (not half-accepted)", async function () {
    const { root, dir } = mkDir();
    const bare = writeBarePacket(root, dir);
    const io = capture();
    const code = await evidence.cmdEvidence(["verify-signed", bare], io);
    expect(code).to.equal(evidence.EXIT.IO);
    expect(io.err()).to.match(/not a signed evidence packet/);
    expect(io.err()).to.contain("vh evidence verify");
  });

  it("an unreadable --dir is a genuine IO error (1), never a silently-skipped binding", async function () {
    const { root, dir } = mkDir();
    const fx = await writeSignedPacket(root, dir);
    const io = capture();
    const code = await evidence.cmdEvidence(
      ["verify-signed", fx.packetPath, "--dir", "/no/such/dir/at/all"],
      io
    );
    expect(code).to.equal(evidence.EXIT.IO);
  });

  // =====================================================================================================
  // `vh evidence verify` — the SILENT CLAIM, CLOSED
  // =====================================================================================================

  it("verify on a GENUINE signed packet ACCEPTS the content but labels the signer UNVERIFIED + points at verify-signed", async function () {
    const { root, dir } = mkDir();
    const fx = await writeSignedPacket(root, dir);
    const io = capture();
    const code = await evidence.cmdEvidence(["verify", fx.packetPath, "--dir", dir], io);
    expect(code).to.equal(evidence.EXIT.OK); // content matches + signature genuine
    const out = io.out();
    // It does NOT report the claimed signer as trusted: it labels it UNVERIFIED-for-pinning...
    expect(out).to.contain("UNVERIFIED");
    // ...and POINTS at `verify-signed` (the command that actually pins/binds).
    expect(out).to.contain("verify-signed");
  });

  it("verify --json on a genuine signed packet exposes a `signature` block (genuine, NOT pinned), never a bare trusted `signer`", async function () {
    const { root, dir } = mkDir();
    const fx = await writeSignedPacket(root, dir);
    const io = capture();
    const code = await evidence.cmdEvidence(["verify", fx.packetPath, "--dir", dir, "--json"], io);
    expect(code).to.equal(evidence.EXIT.OK);
    const j = JSON.parse(io.out());
    expect(j.signed).to.equal(true);
    expect(j.verdict).to.equal("ACCEPTED"); // content + genuine signature
    // The signature block is HONEST: the signer is GENUINE but NOT pinned to anyone the caller trusts.
    expect(j.signature).to.be.an("object");
    expect(j.signature.signatureMatchesSigner).to.equal(true);
    expect(j.signature.recoveredSigner).to.equal(fx.wallet.address.toLowerCase());
    expect(j.signature.claimedSigner).to.equal(fx.wallet.address.toLowerCase());
    expect(j.signature.pinned).to.equal(false);
    expect(j.signature.hint).to.contain("verify-signed");
    // There is NO bare top-level `signer` field that conflates "claimed" with "trusted".
    expect(j).to.not.have.property("signer");
  });

  it("verify REJECTS a FORGED signed packet even when the content matches (exit 3) — the unbacked signer label is sufficient", async function () {
    const { root, dir } = mkDir();
    const entries = evidence.loadDirEntries(path.resolve(dir));
    const seal = evidence.buildSeal(entries);
    const claimant = Wallet.createRandom(); // TEST-ONLY
    const imposter = Wallet.createRandom(); // TEST-ONLY
    const imposterContainer = await evidence.signSealWith(seal, imposter);
    const forged = JSON.parse(JSON.stringify(imposterContainer));
    forged.signature.signer = claimant.address.toLowerCase();
    evidence.validateSignedSeal(forged);
    const packetPath = path.join(root, "forged.vhevidence.json");
    fs.writeFileSync(packetPath, coreAttestation.serializeSignedAttestation(forged, evidence.SIGNED_SEAL_CFG));

    // The CONTENT matches the dir (the bytes are the same — only the signature is forged).
    const io = capture();
    const code = await evidence.cmdEvidence(["verify", packetPath, "--dir", dir, "--json"], io);
    expect(code).to.equal(evidence.EXIT.FAIL); // REJECTED on the forged signature alone
    const j = JSON.parse(io.out());
    expect(j.verdict).to.equal("REJECTED");
    expect(j.contentAccepted).to.equal(true); // the CONTENT alone re-derived fine...
    expect(j.signature.signatureMatchesSigner).to.equal(false); // ...but the signature is forged
    expect(j.signature.recoveredSigner).to.equal(imposter.address.toLowerCase());
    expect(j.signature.claimedSigner).to.equal(claimant.address.toLowerCase());

    // The human path NAMES the forgery + still REJECTS.
    const hio = capture();
    await evidence.cmdEvidence(["verify", packetPath, "--dir", dir], hio);
    expect(hio.out()).to.contain("FORGED");
    expect(hio.out()).to.contain("verify-signed");
  });

  it("verify on a BARE unsigned packet is UNCHANGED: no signature section, accepts the matching dir (exit 0)", async function () {
    const { root, dir } = mkDir();
    const bare = writeBarePacket(root, dir);
    const io = capture();
    const code = await evidence.cmdEvidence(["verify", bare, "--dir", dir, "--json"], io);
    expect(code).to.equal(evidence.EXIT.OK);
    const j = JSON.parse(io.out());
    expect(j.signed).to.equal(false);
    expect(j.verdict).to.equal("ACCEPTED");
    expect(j.signature).to.equal(null); // no signature section for a bare packet
    // The bare human path carries NO signature line (unchanged behavior).
    const hio = capture();
    await evidence.cmdEvidence(["verify", bare, "--dir", dir], hio);
    expect(hio.out()).to.not.contain("UNVERIFIED");
    expect(hio.out()).to.not.contain("signature:");
  });

  it("verify on a bare unsigned packet with an EDITED file still reports exactly that file CHANGED (exit 3) — unchanged", async function () {
    const { root, dir } = mkDir({ "a.txt": "AAA\n", "b.txt": "BBB\n" });
    const bare = writeBarePacket(root, dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "EDITED\n"); // tamper one file
    const io = capture();
    const code = await evidence.cmdEvidence(["verify", bare, "--dir", dir, "--json"], io);
    expect(code).to.equal(evidence.EXIT.FAIL);
    const j = JSON.parse(io.out());
    expect(j.verdict).to.equal("REJECTED");
    expect(j.counts.changed).to.equal(1);
    expect(j.changed.map((c) => c.relPath)).to.deep.equal(["a.txt"]);
    expect(j.signature).to.equal(null);
  });

  it("the evidence usage names verify-signed as a subcommand", function () {
    const u = evidence.evidenceUsage();
    expect(u).to.contain("verify-signed");
    // An unknown subcommand error names verify-signed in the expected set.
    const io = capture();
    return Promise.resolve(evidence.cmdEvidence(["bogus"], io)).then(() => {
      expect(io.err()).to.contain("verify-signed");
    });
  });
});

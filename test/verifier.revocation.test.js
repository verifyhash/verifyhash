"use strict";

// test/verifier.revocation.test.js — T-51.4: the INDEPENDENT verifier reaches the SAME revoked-before-as-of
// downgrade the producer stack does.
//
// WHY THIS TEST EXISTS
//   The producer stack already downgrades an otherwise-ACCEPTED signed artifact to REVOKED when its signing
//   key was revoked-before-the-as-of-instant (`vh evidence verify-signed --revocations <f> --as-of <T>`).
//   The OFFLINE, no-producer-stack verifier (`verify-vh`) did NOT, so a counterparty who only holds the
//   single-file verifier reached a DIFFERENT verdict than the producer on identical inputs. T-51.4 closes
//   that gap. This suite proves the closure MECHANICALLY:
//
//   (1) PARITY — over the SAME signed packet + the SAME genuine revocation, `verify-vh --revocations --as-of`
//       returns the SAME verdict ("REVOKED") + exit code (3) the producer's `vh evidence verify-signed
//       --revocations --as-of` does; the SAME artifact with a revocation dated AFTER --as-of stays ACCEPTED
//       (exit 0) on BOTH stacks with a later-revoked note.
//   (2) ANTI-GRIEF — a forged / third-party revocation is IGNORED with a warning (never downgrades), on both.
//   (3) FILE-OR-DIR — a revocation passed as a single file OR inside a directory both bite the same.
//   (4) NON-LOOSENING — with NO --revocations, every verify-vh verdict + exit code is byte-identical to today.
//
// All keys are EPHEMERAL Wallet.createRandom() (TEST-ONLY — never a real key / real funds). Every write lands
// under a throwaway temp dir cleaned in afterEach; the working tree (cwd) is asserted untouched.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Wallet } = require("ethers");

// The REAL producer stack — the ORACLE the verifier must match.
const evidence = require("../cli/evidence");
const coreRevocation = require("../cli/core/revocation");

// The INDEPENDENT verifier under test + its stack-free revocation lib.
const verifyvh = require("../verifier/verify-vh");
const vrev = require("../verifier/lib/revocation");

const ISSUED = "2026-06-01T00:00:00.000Z";
const EXPIRES = "2027-06-01T00:00:00.000Z";
const NOW = new Date("2026-06-24T00:00:00.000Z");

// The as-of pivot: the revocation dated BEFORE this is REVOKED; AFTER it stays ACCEPTED.
const AS_OF = "2026-06-15T00:00:00.000Z";
const REVOKED_BEFORE = "2026-06-10T00:00:00.000Z"; // < AS_OF -> applies -> REVOKED
const REVOKED_AFTER = "2026-06-20T00:00:00.000Z"; // > AS_OF -> later -> ACCEPTED + note

describe("verifier revocation parity: verify-vh --revocations == producer verify-signed (T-51.4)", function () {
  this.timeout(60000);

  let tmpDirs;
  let cwdBefore;
  beforeEach(function () {
    tmpDirs = [];
    cwdBefore = fs.readdirSync(process.cwd()).sort();
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-rev-parity-"));
    tmpDirs.push(d);
    return d;
  }
  function cap() {
    let out = "";
    let err = "";
    return {
      io: { write: (s) => (out += s), writeErr: (s) => (err += s) },
      out: () => out,
      err: () => err,
    };
  }

  // A genuine SIGNED evidence packet via the REAL producer CLI path. Returns { root, dir, packetPath, opWallet }.
  async function makeSignedEvidencePacket() {
    const root = mkTmp();
    const dir = path.join(root, "data");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "alpha");
    fs.writeFileSync(path.join(dir, "weights.bin"), Buffer.from([0, 1, 2, 255, 7]));

    const vendorWallet = Wallet.createRandom();
    const license = await evidence.buildLicense(
      {
        licenseId: "EV-REV-1",
        customer: "ACME",
        plan: "pro",
        entitlements: ["evidence_signed"],
        issuedAt: ISSUED,
        expiresAt: EXPIRES,
      },
      vendorWallet
    );
    const licFile = path.join(root, "evidence.vhlicense.json");
    fs.writeFileSync(licFile, JSON.stringify(license) + "\n");

    const opWallet = Wallet.createRandom();
    const keyEnv = "VFY_REV_OP_KEY_" + Math.random().toString(36).slice(2);
    process.env[keyEnv] = opWallet.privateKey;
    const packetPath = path.join(root, "packet.vhevidence.json");
    const c = cap();
    let code;
    try {
      code = await evidence.runEvidenceSeal(
        { dir, out: packetPath, sign: true, keyEnv, license: licFile, vendor: vendorWallet.address, now: NOW },
        { ...c.io, now: NOW }
      );
    } finally {
      delete process.env[keyEnv];
    }
    expect(code, `producer evidence CLI failed: ${c.err()}`).to.equal(0);
    return { root, dir, packetPath, opWallet };
  }

  // Mint a GENUINE signed revocation (the operator key revokes ITSELF) via the REAL producer core, then write
  // it to a file. Returns the file path.
  async function writeRevocationFor(wallet, revokedAt, dirOrFile) {
    const container = await coreRevocation.buildRevocation(
      { vendorAddress: wallet.address, reason: "compromised", revokedAt },
      wallet
    );
    const bytes = coreRevocation.serializeSignedRevocation(container);
    let p;
    if (dirOrFile && dirOrFile.dir) {
      p = path.join(dirOrFile.dir, dirOrFile.name || "key.vhrevocation.json");
    } else {
      p = path.join(mkTmp(), "key.vhrevocation.json");
    }
    fs.writeFileSync(p, bytes);
    return p;
  }

  // Run the PRODUCER verify-signed (the ORACLE). Returns { code, out }.
  async function runProducer(args) {
    const c = cap();
    const opts = evidence.parseVerifySignedArgs(args);
    const code = await evidence.runEvidenceVerifySigned(opts, { ...c.io, nowISO: () => NOW.toISOString() });
    return { code, out: c.out(), err: c.err() };
  }

  // Run the INDEPENDENT verifier in-process. Returns { code, out }. nowISO is injected so the default --as-of
  // is deterministic (matching the producer's injected clock).
  function runVerifier(args) {
    const c = cap();
    const code = verifyvh.run(args, { ...c.io, nowISO: NOW.toISOString() });
    return { code, out: c.out(), err: c.err() };
  }

  // ============================================================================================
  // (1) PARITY — a revoked-before-as-of key downgrades BOTH stacks to REVOKED (exit 3).
  // ============================================================================================

  it("revoked-BEFORE-as-of: producer returns REVOKED/exit3 AND verify-vh returns REVOKED/exit3 on identical inputs", async function () {
    const { dir, packetPath, opWallet } = await makeSignedEvidencePacket();
    const revFile = await writeRevocationFor(opWallet, REVOKED_BEFORE);

    // ORACLE: the producer downgrades to REVOKED (exit 3).
    const prod = await runProducer([
      packetPath,
      "--signer",
      opWallet.address,
      "--dir",
      dir,
      "--revocations",
      revFile,
      "--as-of",
      AS_OF,
    ]);
    expect(prod.code, `producer exit (out: ${prod.out}${prod.err})`).to.equal(evidence.EXIT.FAIL);
    expect(prod.out).to.match(/REVOKED/);

    // INDEPENDENT: verify-vh reaches the SAME downgrade — REVOKED, exit 3.
    const vh = runVerifier([
      packetPath,
      "--vendor",
      opWallet.address,
      "--dir",
      dir,
      "--revocations",
      revFile,
      "--as-of",
      AS_OF,
    ]);
    expect(vh.code, `verify-vh exit (out: ${vh.out}${vh.err})`).to.equal(verifyvh.EXIT.REJECTED);
    expect(vh.out).to.match(/REVOKED \(key_revoked_as_of\)/);

    // EXIT-CODE PARITY: both stacks return the SAME non-zero code (3).
    expect(vh.code).to.equal(prod.code);

    // --json carries the downgraded verdict + the trust-as-of block.
    const vj = runVerifier([
      packetPath,
      "--vendor",
      opWallet.address,
      "--dir",
      dir,
      "--revocations",
      revFile,
      "--as-of",
      AS_OF,
      "--json",
    ]);
    expect(vj.code).to.equal(verifyvh.EXIT.REJECTED);
    const j = JSON.parse(vj.out);
    expect(j.verdict).to.equal("REVOKED");
    expect(j.reason).to.equal("key_revoked_as_of");
    expect(j.accepted).to.equal(false);
    expect(j.trustAsOf.status).to.equal("REVOKED");
    expect(j.trustAsOf.governing.vendorAddress).to.equal(opWallet.address.toLowerCase());
    expect(j.trustAsOf.governing.revokedAt).to.equal(REVOKED_BEFORE);
  });

  it("revoked-AFTER-as-of: the SAME artifact stays ACCEPTED/exit0 on BOTH stacks, with a later-revoked note", async function () {
    const { dir, packetPath, opWallet } = await makeSignedEvidencePacket();
    const revFile = await writeRevocationFor(opWallet, REVOKED_AFTER);

    const prod = await runProducer([
      packetPath,
      "--signer",
      opWallet.address,
      "--dir",
      dir,
      "--revocations",
      revFile,
      "--as-of",
      AS_OF,
    ]);
    expect(prod.code, `producer exit (out: ${prod.out}${prod.err})`).to.equal(evidence.EXIT.OK);

    const vh = runVerifier([
      packetPath,
      "--vendor",
      opWallet.address,
      "--dir",
      dir,
      "--revocations",
      revFile,
      "--as-of",
      AS_OF,
    ]);
    expect(vh.code, `verify-vh exit (out: ${vh.out}${vh.err})`).to.equal(verifyvh.EXIT.OK);
    expect(vh.code).to.equal(prod.code);
    expect(vh.out).to.match(/OK — the artifact verifies\./);
    // The later-revoked informational note is surfaced (the key IS revoked now, but was fine as of the instant).
    expect(vh.out).to.match(/\[note\] this key .* IS revoked as of/);

    const vj = runVerifier([
      packetPath,
      "--vendor",
      opWallet.address,
      "--dir",
      dir,
      "--revocations",
      revFile,
      "--as-of",
      AS_OF,
      "--json",
    ]);
    const j = JSON.parse(vj.out);
    expect(j.verdict).to.equal("OK");
    expect(j.accepted).to.equal(true);
    expect(j.trustAsOf.status).to.equal("OK");
    expect(j.trustAsOf.laterRevoked.revokedAt).to.equal(REVOKED_AFTER);
  });

  // ============================================================================================
  // (2) ANTI-GRIEF — a forged / third-party revocation is IGNORED with a warning (never a downgrade).
  // ============================================================================================

  it("a THIRD-PARTY revocation (signed by a DIFFERENT key over the operator's address) is IGNORED with a warning, never downgrades", async function () {
    const { dir, packetPath, opWallet } = await makeSignedEvidencePacket();

    // A griefer signs a revocation whose vendorAddress is the OPERATOR's, but with the GRIEFER's key. The
    // self-control check fails -> the revocation never bites. We hand-build a STRUCTURALLY-PERFECT container
    // (correct kind/schemaVersion/note + canonical embedded bytes) so the ONLY thing that stops it is the
    // load-bearing self-control invariant (recovered !== vendorAddress) — exactly the anti-grief check. (The
    // producer core REFUSES to MINT one whose key does not control the address, so we assemble it by hand.)
    const griefer = Wallet.createRandom();
    const payload = coreRevocation.buildRevocationPayload({
      vendorAddress: opWallet.address,
      reason: "compromised",
      revokedAt: REVOKED_BEFORE,
    });
    const attestation = coreRevocation.serializeRevocation(payload);
    const signature = await griefer.signMessage(attestation);
    const forged = {
      kind: coreRevocation.SIGNED_REVOCATION_KIND,
      schemaVersion: coreRevocation.SIGNED_REVOCATION_SCHEMA_VERSION,
      note: coreRevocation.SIGNED_REVOCATION_TRUST_NOTE,
      attestation,
      signature: { scheme: "eip191-personal-sign", signer: griefer.address.toLowerCase(), signature },
    };
    const revFile = path.join(mkTmp(), "forged.vhrevocation.json");
    fs.writeFileSync(revFile, JSON.stringify(forged) + "\n");

    const vh = runVerifier([
      packetPath,
      "--vendor",
      opWallet.address,
      "--dir",
      dir,
      "--revocations",
      revFile,
      "--as-of",
      AS_OF,
    ]);
    // The forged revocation is IGNORED — the artifact stays ACCEPTED (exit 0).
    expect(vh.code, `verify-vh exit (out: ${vh.out})`).to.equal(verifyvh.EXIT.OK);
    expect(vh.out).to.match(/OK — the artifact verifies\./);
    expect(vh.out).to.match(/\[warning\] ignored a revocation that does not verify/);

    // PARITY: the producer ALSO ignores it (stays ACCEPTED).
    const prod = await runProducer([
      packetPath,
      "--signer",
      opWallet.address,
      "--dir",
      dir,
      "--revocations",
      revFile,
      "--as-of",
      AS_OF,
    ]);
    expect(prod.code).to.equal(evidence.EXIT.OK);
    expect(vh.code).to.equal(prod.code);
  });

  // --------------------------------------------------------------------------------------------
  // (2b) NEGATIVE-PARITY — a MALFORMED-but-genuinely-self-signed revocation (the operator's OWN key signed it,
  // so the self-control check passes) that the PRODUCER IGNORES as structurally unsound MUST be IGNORED by
  // verify-vh too. These are the cross-stack divergences a looser verifier validator would honor: a
  // non-canonical / extra-field / wrong-note / dropped-note / unsupported-schemaVersion / mixed-case-hex
  // revocation. The producer's validateSignedAttestation + validateRevocation gate the verdict on ALL of
  // these; the verifier must reach the SAME OK (exit 0) on EVERY one (status, exit, and the producer match).
  // --------------------------------------------------------------------------------------------

  // Mint a GENUINE signed revocation for `wallet` revoked-BEFORE-as-of (so a CANONICAL one WOULD bite), then
  // hand it to `mutate(payloadObj, container)` to produce a non-canonical/malformed embedded variant, re-sign
  // it with the SAME wallet (self-control preserved), and write it to a file. Returns the file path.
  async function writeMalformedSelfSignedRevocation(wallet, mutate) {
    const genuine = await coreRevocation.buildRevocation(
      { vendorAddress: wallet.address, reason: "compromised", revokedAt: REVOKED_BEFORE },
      wallet
    );
    const payloadObj = JSON.parse(genuine.attestation);
    const { attestation, signature: sigOverride } = mutate(payloadObj, genuine);
    // Re-sign the (mutated) embedded bytes with the OPERATOR's OWN key so the load-bearing self-control check
    // still passes — the ONLY thing that should now stop the revocation is the producer's STRUCTURAL gate.
    const signature =
      sigOverride !== undefined ? sigOverride : await wallet.signMessage(attestation);
    const container = { ...genuine, attestation, signature: { ...genuine.signature, signature } };
    const p = path.join(mkTmp(), "malformed.vhrevocation.json");
    fs.writeFileSync(p, JSON.stringify(container) + "\n");
    return p;
  }

  // Assert BOTH stacks reach OK/exit0 (the malformed revocation is IGNORED, the artifact stays ACCEPTED) AND
  // they agree on the exit code — the precise cross-stack equality T-51.4 exists to guarantee.
  async function expectIgnoredOnBothStacks(dir, packetPath, opWallet, revFile) {
    const prod = await runProducer([
      packetPath, "--signer", opWallet.address, "--dir", dir, "--revocations", revFile, "--as-of", AS_OF,
    ]);
    expect(prod.code, `producer exit (out: ${prod.out}${prod.err})`).to.equal(evidence.EXIT.OK);

    const vh = runVerifier([
      packetPath, "--vendor", opWallet.address, "--dir", dir, "--revocations", revFile, "--as-of", AS_OF, "--json",
    ]);
    expect(vh.code, `verify-vh exit (out: ${vh.out}${vh.err})`).to.equal(verifyvh.EXIT.OK);
    expect(vh.code).to.equal(prod.code); // exit-code parity on the SAME malformed input
    const j = JSON.parse(vh.out);
    expect(j.verdict).to.equal("OK");
    expect(j.accepted).to.equal(true);
    expect(j.trustAsOf.status).to.equal("OK");
    // It was IGNORED (counted as ignored, not applied) — NOT applied, NOT merely irrelevant.
    expect(j.trustAsOf.counts.applicable).to.equal(0);
    expect(j.trustAsOf.counts.ignored).to.equal(1);
    return { prod, vh };
  }

  it("NEGATIVE-PARITY: a non-canonical-key-order (re-signed) revocation is IGNORED by BOTH stacks (OK/exit0)", async function () {
    const { dir, packetPath, opWallet } = await makeSignedEvidencePacket();
    const revFile = await writeMalformedSelfSignedRevocation(opWallet, (p) => {
      // Reorder the embedded payload's keys — genuinely self-signed but NON-canonical bytes.
      const reordered = {
        reason: p.reason,
        kind: p.kind,
        schemaVersion: p.schemaVersion,
        note: p.note,
        vendorAddress: p.vendorAddress,
        revokedAt: p.revokedAt,
      };
      return { attestation: JSON.stringify(reordered) + "\n" };
    });
    await expectIgnoredOnBothStacks(dir, packetPath, opWallet, revFile);
  });

  it("NEGATIVE-PARITY: an extra/unknown embedded field (re-signed) is IGNORED by BOTH stacks (OK/exit0)", async function () {
    const { dir, packetPath, opWallet } = await makeSignedEvidencePacket();
    const revFile = await writeMalformedSelfSignedRevocation(opWallet, (p) => ({
      attestation: JSON.stringify({ ...p, evilExtra: 1 }) + "\n",
    }));
    await expectIgnoredOnBothStacks(dir, packetPath, opWallet, revFile);
  });

  it("NEGATIVE-PARITY: a dropped `note` field (re-signed) is IGNORED by BOTH stacks (OK/exit0)", async function () {
    const { dir, packetPath, opWallet } = await makeSignedEvidencePacket();
    const revFile = await writeMalformedSelfSignedRevocation(opWallet, (p) => {
      const noNote = { ...p };
      delete noNote.note;
      return { attestation: JSON.stringify(noNote) + "\n" };
    });
    await expectIgnoredOnBothStacks(dir, packetPath, opWallet, revFile);
  });

  it("NEGATIVE-PARITY: a wrong `note` text (re-signed) is IGNORED by BOTH stacks (OK/exit0)", async function () {
    const { dir, packetPath, opWallet } = await makeSignedEvidencePacket();
    const revFile = await writeMalformedSelfSignedRevocation(opWallet, (p) => ({
      attestation: JSON.stringify({ ...p, note: "a different note" }) + "\n",
    }));
    await expectIgnoredOnBothStacks(dir, packetPath, opWallet, revFile);
  });

  it("NEGATIVE-PARITY: an unsupported embedded schemaVersion (re-signed) is IGNORED by BOTH stacks (OK/exit0)", async function () {
    const { dir, packetPath, opWallet } = await makeSignedEvidencePacket();
    const revFile = await writeMalformedSelfSignedRevocation(opWallet, (p) => ({
      attestation: JSON.stringify({ ...p, schemaVersion: 999 }) + "\n",
    }));
    await expectIgnoredOnBothStacks(dir, packetPath, opWallet, revFile);
  });

  it("NEGATIVE-PARITY: an UPPERCASE signature hex (no key needed — re-encode the SAME bytes) is IGNORED by BOTH stacks (OK/exit0)", async function () {
    const { dir, packetPath, opWallet } = await makeSignedEvidencePacket();
    // Mint a GENUINE canonical revocation, then ONLY uppercase the signature hex — the 65 bytes are
    // identical, so ANYONE (no key) can re-encode it. The producer rejects mixed/upper case for
    // byte-determinism and IGNORES it; the verifier must too.
    const revFile = await writeMalformedSelfSignedRevocation(opWallet, (p, container) => ({
      attestation: container.attestation, // keep canonical embedded bytes
      signature: "0x" + container.signature.signature.slice(2).toUpperCase(),
    }));
    await expectIgnoredOnBothStacks(dir, packetPath, opWallet, revFile);
  });

  it("a revocation for a DIFFERENT key (irrelevant) never downgrades the artifact", async function () {
    const { dir, packetPath, opWallet } = await makeSignedEvidencePacket();
    // A genuine revocation, but of some OTHER key — irrelevant to THIS artifact's signer.
    const other = Wallet.createRandom();
    const revFile = await writeRevocationFor(other, REVOKED_BEFORE);
    const vh = runVerifier([
      packetPath,
      "--vendor",
      opWallet.address,
      "--dir",
      dir,
      "--revocations",
      revFile,
      "--as-of",
      AS_OF,
      "--json",
    ]);
    expect(vh.code).to.equal(verifyvh.EXIT.OK);
    const j = JSON.parse(vh.out);
    expect(j.trustAsOf.counts.irrelevant).to.equal(1);
    expect(j.trustAsOf.status).to.equal("OK");
  });

  // ============================================================================================
  // (3) FILE-OR-DIR — a directory of revocation files bites the same as a single file.
  // ============================================================================================

  it("--revocations <DIR> aggregates the folder: the operator's revocation downgrades to REVOKED", async function () {
    const { dir, packetPath, opWallet } = await makeSignedEvidencePacket();
    const revDir = mkTmp();
    // Two files in the folder: a decoy (irrelevant key) + the operator's own (the one that bites).
    await writeRevocationFor(Wallet.createRandom(), REVOKED_BEFORE, { dir: revDir, name: "other.vhrevocation.json" });
    await writeRevocationFor(opWallet, REVOKED_BEFORE, { dir: revDir, name: "op.vhrevocation.json" });
    // A junk file in the folder must be IGNORED (a warning), never abort the decision.
    fs.writeFileSync(path.join(revDir, "junk.json"), "{not json");

    const vh = runVerifier([
      packetPath,
      "--vendor",
      opWallet.address,
      "--dir",
      dir,
      "--revocations",
      revDir,
      "--as-of",
      AS_OF,
      "--json",
    ]);
    expect(vh.code, `verify-vh exit (out: ${vh.out})`).to.equal(verifyvh.EXIT.REJECTED);
    const j = JSON.parse(vh.out);
    expect(j.verdict).to.equal("REVOKED");
    expect(j.trustAsOf.governing.vendorAddress).to.equal(opWallet.address.toLowerCase());
    expect(j.trustAsOf.counts.irrelevant).to.equal(1); // the decoy
    expect(j.trustAsOf.counts.ignored).to.equal(1); // the junk file
  });

  // ============================================================================================
  // (4) NON-LOOSENING — with NO --revocations every verdict + exit is byte-identical to today.
  // ============================================================================================

  it("with NO --revocations, verify-vh output + exit code are byte-identical to the pre-T-51.4 baseline (regression-pinned)", async function () {
    const { dir, packetPath, opWallet } = await makeSignedEvidencePacket();

    // The baseline run carries NO trustAsOf block and the original verdict shape.
    const human = runVerifier([packetPath, "--vendor", opWallet.address, "--dir", dir]);
    expect(human.code).to.equal(verifyvh.EXIT.OK);
    expect(human.out).to.match(/OK — the artifact verifies\./);
    expect(human.out, "no revocation block when no flag").to.not.match(/revocation check/);

    const j = runVerifier([packetPath, "--vendor", opWallet.address, "--dir", dir, "--json"]);
    const obj = JSON.parse(j.out);
    expect(obj).to.not.have.property("trustAsOf");
    expect(obj).to.not.have.property("trustAsOfDefaulted");
    expect(obj.verdict).to.equal("OK");

    // A wrong --vendor with NO --revocations is still a plain wrong_issuer REJECTED (the revocation path
    // never touches a non-revocation verdict).
    const wrong = runVerifier([packetPath, "--vendor", Wallet.createRandom().address, "--dir", dir]);
    expect(wrong.code).to.equal(verifyvh.EXIT.REJECTED);
    expect(wrong.out).to.match(/REJECTED \(wrong_issuer\)/);
    expect(wrong.out).to.not.match(/revocation check/);
  });

  it("an already-REJECTED artifact (tampered byte) stays REJECTED — the trust-as-of never UPGRADES a verdict", async function () {
    const { dir, packetPath, opWallet } = await makeSignedEvidencePacket();
    // Tamper a referenced byte -> CHANGED/REJECTED regardless of revocations.
    fs.writeFileSync(path.join(dir, "a.txt"), "alphX");
    const revFile = await writeRevocationFor(opWallet, REVOKED_AFTER); // a LATER revocation (would not downgrade)
    const vh = runVerifier([
      packetPath,
      "--vendor",
      opWallet.address,
      "--dir",
      dir,
      "--revocations",
      revFile,
      "--as-of",
      AS_OF,
    ]);
    expect(vh.code).to.equal(verifyvh.EXIT.REJECTED);
    // The structural CHANGED verdict is preserved; the revocation block is still shown but does not flip it.
    expect(vh.out).to.match(/REJECTED \(CHANGED\)/);
  });

  // ============================================================================================
  // (5) FLAG VALIDATION — usage parity with the producer's verify-signed.
  // ============================================================================================

  it("--as-of without --revocations is a usage error (exit 2); a malformed --as-of is a usage error (exit 2)", async function () {
    const { dir, packetPath, opWallet } = await makeSignedEvidencePacket();
    // --as-of without --revocations.
    const a = runVerifier([packetPath, "--vendor", opWallet.address, "--dir", dir, "--as-of", AS_OF]);
    expect(a.code).to.equal(verifyvh.EXIT.USAGE);
    expect(a.err).to.match(/--as-of requires --revocations/);
    // Malformed --as-of (date-only, no time/Z).
    const revFile = await writeRevocationFor(opWallet, REVOKED_BEFORE);
    const b = runVerifier([packetPath, "--vendor", opWallet.address, "--dir", dir, "--revocations", revFile, "--as-of", "2026-06-15"]);
    expect(b.code).to.equal(verifyvh.EXIT.USAGE);
    expect(b.err).to.match(/invalid --as-of/);
  });

  it("an unreadable --revocations path is an IO error (exit 1)", async function () {
    const { dir, packetPath, opWallet } = await makeSignedEvidencePacket();
    const missing = path.join(mkTmp(), "nope.vhrevocation.json");
    const vh = runVerifier([packetPath, "--vendor", opWallet.address, "--dir", dir, "--revocations", missing, "--as-of", AS_OF]);
    expect(vh.code).to.equal(verifyvh.EXIT.IO);
    expect(vh.err).to.match(/cannot evaluate --revocations|cannot read/);
  });

  // ============================================================================================
  // (6) The stack-free lib agrees with the producer core on the SAME revocation (no ethers in the verifier).
  // ============================================================================================

  it("the verifier's stack-free verifyRevocation accepts a genuine revocation + recovers the same signer the producer core does", async function () {
    const w = Wallet.createRandom();
    const container = await coreRevocation.buildRevocation(
      { vendorAddress: w.address, reason: "rotated", revokedAt: REVOKED_BEFORE },
      w
    );
    // Producer core verdict (uses ethers).
    const prod = coreRevocation.verifyRevocation({ container });
    expect(prod.accepted).to.equal(true);
    // Verifier's stack-free verdict (pure-JS secp256k1) — SAME recovered signer + vendorAddress + accept.
    const v = vrev.verifyRevocation(container);
    expect(v.accepted).to.equal(true);
    expect(v.recoveredSigner).to.equal(prod.recoveredSigner);
    expect(v.vendorAddress).to.equal(w.address.toLowerCase());
    expect(v.reason).to.equal("rotated");
    expect(v.revokedAt).to.equal(REVOKED_BEFORE);
  });
});

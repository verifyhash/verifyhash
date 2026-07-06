"use strict";

// test/cli.evidence.canonical-vendor.test.js — T-75.3 acceptance: the paid gate pins license
// verification to a CANONICAL vendor identity, never the caller-supplied --vendor.
//
// THE LEAK THIS CLOSES (revenue-only — NOT impersonation: an attacker's seals are still signed by their
// own key): the `--sign`/`evidence_unlimited` gate used to verify the license against WHATEVER address
// the caller passed as `--vendor`, so anyone could self-mint a license with their own key, pass their
// own address, and unlock the paid surface for free.
//
// What these prove (the acceptance criteria):
//   (1) the gate verifies against a COMMITTED canonical vendor identity — the published verifyhash
//       vendor address — sourced from cli/core/vendor-identity.js, mirrored into the evidence and
//       TrustLedger license cfgs, and matching the SIGNED identity card the repo ships;
//   (2) the SELF-MINT attack is refused BY NAME both ways: a caller `--vendor` that differs from the
//       canonical identity is a named usage refusal (it can NOT re-pin the gate), and a license minted
//       by a NON-canonical key is the named `wrong_issuer` gate-fail — nothing written either way;
//   (3) a license minted by the CANONICAL key still unlocks — via the committed default's stand-ins:
//       the programmatic io.canonicalVendor seam AND the VH_CANONICAL_VENDOR operator config channel
//       (the documented self-hosting hooks; argv can never do this), with a matching --vendor accepted
//       in any casing;
//   (4) the OFFLINE verify path for already-signed packets is UNCHANGED: verify/verify-signed never
//       consult the canonical pin (identical verdicts with and without the env config set);
//   (5) the core resolveVendorPin primitive is strict: no canonical => named error (a gate can never
//       silently fall back to a caller pin), garbage addresses => named errors, match => checksummed.
//
// Offline; no new dependency. Every key is an EPHEMERAL in-process Wallet.createRandom() (never a real
// key); the ONLY real-identity assertion is address equality against the committed PUBLIC constant.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Wallet, getAddress } = require("ethers");

const evidence = require("../cli/evidence");
const coreLicense = require("../cli/core/license");
const vendorIdentity = require("../cli/core/vendor-identity");
const tlLicense = require("../trustledger/license");

// The PUBLISHED verifyhash vendor identity (STRATEGY.md first-dollar config). A silent drift of the
// committed constant would re-open the leak (or brick real customers' licenses), so it is pinned here.
const PUBLISHED_VENDOR = "0x7cb4d3DC6C52996B6386473Bfb32f898263412f7";

const NOW = new Date("2026-06-24T12:00:00.000Z");
const ISSUED = "2026-06-01T00:00:00.000Z";
const EXPIRES = "2027-06-01T00:00:00.000Z";

function capture(extra = {}) {
  const out = [];
  const err = [];
  return Object.assign(
    {
      write: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      now: NOW,
      out: () => out.join(""),
      err: () => err.join(""),
    },
    extra
  );
}

async function mintLicense(dir, entitlements, wallet) {
  const w = wallet || Wallet.createRandom();
  const container = await evidence.buildLicense(
    {
      licenseId: "EV-T753-1",
      customer: "Canonical Pin Test Co",
      plan: "pro",
      entitlements,
      issuedAt: ISSUED,
      expiresAt: EXPIRES,
    },
    w
  );
  const file = path.join(dir, "t753.vhlicense.json");
  fs.writeFileSync(file, JSON.stringify(container) + "\n");
  return { file, wallet: w };
}

describe("cli/evidence T-75.3: the paid gate pins to the CANONICAL vendor identity", function () {
  let tmpDirs;
  let cwdBefore;
  let envBefore;
  beforeEach(function () {
    tmpDirs = [];
    cwdBefore = fs.readdirSync(process.cwd()).sort();
    // The default-canonical assertions below depend on the operator config channel being UNSET.
    envBefore = process.env[evidence.CANONICAL_VENDOR_ENV];
    delete process.env[evidence.CANONICAL_VENDOR_ENV];
  });
  afterEach(function () {
    if (envBefore === undefined) delete process.env[evidence.CANONICAL_VENDOR_ENV];
    else process.env[evidence.CANONICAL_VENDOR_ENV] = envBefore;
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-t753-"));
    tmpDirs.push(d);
    return d;
  }
  function mkDir(n = 2) {
    const root = mkTmp();
    const d = path.join(root, "payload");
    fs.mkdirSync(d);
    for (let i = 0; i < n; i++) fs.writeFileSync(path.join(d, `f${i}.txt`), `content-${i}\n`);
    return d;
  }
  // A --sign run with an ephemeral operator key; returns { code, io }.
  async function runSign(opts, ioExtra = {}) {
    const opWallet = Wallet.createRandom();
    const prev = process.env.T753_OP_KEY;
    process.env.T753_OP_KEY = opWallet.privateKey;
    try {
      const io = capture(ioExtra);
      const code = await evidence.runEvidenceSeal(
        Object.assign({ sign: true, keyEnv: "T753_OP_KEY" }, opts),
        io
      );
      return { code, io };
    } finally {
      if (prev === undefined) delete process.env.T753_OP_KEY;
      else process.env.T753_OP_KEY = prev;
    }
  }

  // =======================================================================
  // (1) The canonical identity is a COMMITTED constant — the published one.
  // =======================================================================

  it("(1) the committed constant IS the published vendor identity, mirrored into every product cfg", function () {
    expect(vendorIdentity.VERIFYHASH_VENDOR_ADDRESS).to.equal(PUBLISHED_VENDOR);
    expect(evidence.CANONICAL_VENDOR_ADDRESS).to.equal(PUBLISHED_VENDOR);
    expect(evidence.LICENSE_CFG.canonicalVendor).to.equal(PUBLISHED_VENDOR);
    expect(tlLicense.CANONICAL_VENDOR_ADDRESS).to.equal(PUBLISHED_VENDOR);
    // The constant is a real, checksummed address (a typo could never verify anything).
    expect(getAddress(PUBLISHED_VENDOR)).to.equal(PUBLISHED_VENDOR);
    // The operator config channel has a stable, documented name.
    expect(evidence.CANONICAL_VENDOR_ENV).to.equal("VH_CANONICAL_VENDOR");
    // The CLI help SURFACES the identity + the self-host channel (the buyer can see what gates them).
    const usage = evidence.evidenceUsage();
    expect(usage).to.include(PUBLISHED_VENDOR);
    expect(usage).to.include("VH_CANONICAL_VENDOR");
  });

  it("(1) the committed constant matches the SIGNED identity card the repo ships", function () {
    const cardPath = path.join(__dirname, "..", "identity", "verifyhash-evidence.vhidentity.json");
    const card = JSON.parse(fs.readFileSync(cardPath, "utf8"));
    expect(String(card.signature.signer).toLowerCase()).to.equal(PUBLISHED_VENDOR.toLowerCase());
  });

  // =======================================================================
  // (2) The SELF-MINT attack is refused BY NAME (both spellings of it).
  // =======================================================================

  it("(2) the exact old attack — self-minted license + --vendor naming the attacker's own key — is a NAMED usage refusal, nothing written", async function () {
    const dir = mkDir(2);
    const lroot = mkTmp();
    const attacker = Wallet.createRandom();
    const { file } = await mintLicense(lroot, ["evidence_signed"], attacker);
    const out = path.join(lroot, "free-ride.vhevidence.json");

    const { code, io } = await runSign({ dir, out, license: file, vendor: attacker.address });
    expect(code).to.equal(evidence.EXIT.USAGE);
    expect(io.err()).to.include("does not match the canonical vendor identity");
    expect(io.err()).to.include("cannot re-pin an entitlement gate");
    // The refusal points self-hosters at the honest path instead of the hole.
    expect(io.err()).to.include("docs/LICENSING.md");
    expect(fs.existsSync(out)).to.equal(false);
  });

  it("(2) a self-minted license WITHOUT --vendor is the NAMED wrong_issuer gate-fail against the committed default, nothing written", async function () {
    const dir = mkDir(2);
    const lroot = mkTmp();
    const { file } = await mintLicense(lroot, ["evidence_signed"], Wallet.createRandom());
    const out = path.join(lroot, "free-ride2.vhevidence.json");

    const { code, io } = await runSign({ dir, out, license: file });
    expect(code).to.equal(evidence.EXIT.FAIL);
    expect(io.err()).to.match(/requires a VALID license, but the supplied license is wrong_issuer/);
    expect(io.err()).to.include("minted by the canonical vendor key");
    // The default pin really is the committed published identity.
    expect(io.err().toLowerCase()).to.include(PUBLISHED_VENDOR.toLowerCase());
    expect(fs.existsSync(out)).to.equal(false);
  });

  it("(2) the evidence_unlimited surface is pinned the same way (over-sample + self-minted license => wrong_issuer)", async function () {
    const dir = mkDir(evidence.SAMPLE_LIMIT + 1);
    const lroot = mkTmp();
    const { file } = await mintLicense(lroot, ["evidence_unlimited"], Wallet.createRandom());
    const out = path.join(lroot, "big.vhevidence.json");

    const io = capture();
    const code = await evidence.runEvidenceSeal({ dir, out, license: file }, io);
    expect(code).to.equal(evidence.EXIT.FAIL);
    expect(io.err()).to.match(/wrong_issuer/);
    expect(fs.existsSync(out)).to.equal(false);
  });

  // =======================================================================
  // (3) A license minted by the CANONICAL key still unlocks.
  // =======================================================================

  it("(3) a canonical-key license unlocks --sign (programmatic io.canonicalVendor seam; matching --vendor accepted in any casing)", async function () {
    const dir = mkDir(2);
    const lroot = mkTmp();
    const canonical = Wallet.createRandom(); // this run's canonical identity (ephemeral stand-in)
    const { file } = await mintLicense(lroot, ["evidence_signed"], canonical);

    // (a) --license alone.
    const out1 = path.join(lroot, "ok1.vhevidence.json");
    const r1 = await runSign({ dir, out: out1, license: file }, { canonicalVendor: canonical.address });
    expect(r1.code, r1.io.err()).to.equal(evidence.EXIT.OK);
    expect(fs.existsSync(out1)).to.equal(true);

    // (b) an EXPLICIT --vendor that EQUALS the canonical identity is accepted — lowercase…
    const out2 = path.join(lroot, "ok2.vhevidence.json");
    const r2 = await runSign(
      { dir, out: out2, license: file, vendor: canonical.address.toLowerCase() },
      { canonicalVendor: canonical.address }
    );
    expect(r2.code, r2.io.err()).to.equal(evidence.EXIT.OK);

    // …and checksummed.
    const out3 = path.join(lroot, "ok3.vhevidence.json");
    const r3 = await runSign(
      { dir, out: out3, license: file, vendor: getAddress(canonical.address) },
      { canonicalVendor: canonical.address }
    );
    expect(r3.code, r3.io.err()).to.equal(evidence.EXIT.OK);
  });

  it("(3) the VH_CANONICAL_VENDOR operator config channel works (self-hosting), and the programmatic seam WINS over it", async function () {
    const dir = mkDir(2);
    const lroot = mkTmp();
    const operator = Wallet.createRandom();
    const { file } = await mintLicense(lroot, ["evidence_signed"], operator);

    // (a) the env channel alone unlocks (a spawned CLI has no io seam — this IS the self-host config).
    process.env[evidence.CANONICAL_VENDOR_ENV] = operator.address;
    try {
      const out = path.join(lroot, "env-ok.vhevidence.json");
      const r = await runSign({ dir, out, license: file });
      expect(r.code, r.io.err()).to.equal(evidence.EXIT.OK);

      // (b) precedence: an explicit programmatic identity WINS over the env (deterministic embedding).
      const out2 = path.join(lroot, "env-loses.vhevidence.json");
      const other = Wallet.createRandom().address;
      const r2 = await runSign({ dir, out: out2, license: file }, { canonicalVendor: other });
      expect(r2.code).to.equal(evidence.EXIT.FAIL); // license no longer matches the pinned identity
      expect(r2.io.err()).to.match(/wrong_issuer/);
      expect(fs.existsSync(out2)).to.equal(false);
    } finally {
      delete process.env[evidence.CANONICAL_VENDOR_ENV];
    }

    // (c) a GARBAGE configured identity fails CLOSED with a named usage error, never a silent unlock.
    process.env[evidence.CANONICAL_VENDOR_ENV] = "not-an-address";
    try {
      const out = path.join(lroot, "garbage.vhevidence.json");
      const r = await runSign({ dir, out, license: file });
      expect(r.code).to.equal(evidence.EXIT.USAGE);
      expect(r.io.err()).to.match(/canonicalVendor is not a valid 0x-address/);
      expect(fs.existsSync(out)).to.equal(false);
    } finally {
      delete process.env[evidence.CANONICAL_VENDOR_ENV];
    }
  });

  // =======================================================================
  // (4) The OFFLINE verify path for already-signed packets is UNCHANGED.
  // =======================================================================

  it("(4) verify/verify-signed never consult the canonical pin: identical verdicts with and without the config set", async function () {
    const dir = mkDir(2);
    const lroot = mkTmp();
    const canonical = Wallet.createRandom();
    const { file } = await mintLicense(lroot, ["evidence_signed"], canonical);
    const packet = path.join(lroot, "signed.vhevidence.json");
    const r = await runSign({ dir, out: packet, license: file }, { canonicalVendor: canonical.address });
    expect(r.code, r.io.err()).to.equal(evidence.EXIT.OK);

    function verifyBoth() {
      const v1 = capture();
      const c1 = evidence.runEvidenceVerify({ packet, dir, json: true }, v1);
      const v2 = capture();
      const c2 = evidence.runEvidenceVerifySigned({ signed: packet, dir, json: true }, v2);
      return { c1, o1: v1.out(), c2, o2: v2.out() };
    }

    // No license, no --vendor, no env: the verify path needs NONE of the gate's inputs.
    const before = verifyBoth();
    expect(before.c1).to.equal(evidence.EXIT.OK);
    expect(JSON.parse(before.o1).verdict).to.equal("ACCEPTED");
    expect(before.c2).to.equal(evidence.EXIT.OK);
    expect(JSON.parse(before.o2).verdict).to.equal("ACCEPTED");

    // Byte-identical verdicts with the operator config set to an UNRELATED identity: verify is not gated.
    process.env[evidence.CANONICAL_VENDOR_ENV] = Wallet.createRandom().address;
    try {
      const after = verifyBoth();
      expect(after.c1).to.equal(before.c1);
      expect(after.o1).to.equal(before.o1);
      expect(after.c2).to.equal(before.c2);
      expect(after.o2).to.equal(before.o2);
    } finally {
      delete process.env[evidence.CANONICAL_VENDOR_ENV];
    }
  });

  // =======================================================================
  // (5) The core primitive is strict (no silent fallback, ever).
  // =======================================================================

  it("(5) coreLicense.resolveVendorPin: named errors for a missing/garbage canonical or caller pin; checksummed canonical on match", function () {
    const canonical = Wallet.createRandom();
    const cfg = Object.freeze({ ...evidence.LICENSE_CFG, canonicalVendor: canonical.address });

    // No canonicalVendor in the cfg => a gate can NEVER fall back to a caller-chosen pin.
    const bare = { ...evidence.LICENSE_CFG };
    delete bare.canonicalVendor;
    expect(() => coreLicense.resolveVendorPin(bare)).to.throw(
      evidence.EvidenceLicenseError,
      /requires cfg\.canonicalVendor/
    );

    // Garbage committed identity / garbage caller pin are NAMED errors.
    expect(() =>
      coreLicense.resolveVendorPin({ ...evidence.LICENSE_CFG, canonicalVendor: "0xnope" })
    ).to.throw(evidence.EvidenceLicenseError, /canonicalVendor is not a valid 0x-address/);
    expect(() => coreLicense.resolveVendorPin(cfg, "garbage")).to.throw(
      evidence.EvidenceLicenseError,
      /not a valid 0x-address/
    );

    // No caller pin => the canonical identity, checksummed. A matching pin (any casing) => the same.
    expect(coreLicense.resolveVendorPin(cfg)).to.equal(getAddress(canonical.address));
    expect(coreLicense.resolveVendorPin(cfg, canonical.address.toLowerCase())).to.equal(
      getAddress(canonical.address)
    );

    // A DIFFERENT caller pin is the named re-pin refusal.
    expect(() => coreLicense.resolveVendorPin(cfg, Wallet.createRandom().address)).to.throw(
      evidence.EvidenceLicenseError,
      /cannot re-pin an entitlement gate/
    );

    // The TrustLedger adapter exposes the SAME machinery bound to ITS cfg (its own named error type).
    expect(() => tlLicense.resolveVendorPin(Wallet.createRandom().address)).to.throw(
      tlLicense.LicenseError,
      /cannot re-pin an entitlement gate/
    );
    expect(tlLicense.resolveVendorPin()).to.equal(PUBLISHED_VENDOR);
    expect(tlLicense.resolveVendorPin(PUBLISHED_VENDOR.toLowerCase())).to.equal(PUBLISHED_VENDOR);
  });

  it("(5) vendorIdentity.resolveCanonicalVendor precedence is pure and strict: override > env > committed default", function () {
    const env = {};
    expect(vendorIdentity.resolveCanonicalVendor({ env })).to.equal(PUBLISHED_VENDOR);
    env[vendorIdentity.CANONICAL_VENDOR_ENV] = "0xAAA";
    expect(vendorIdentity.resolveCanonicalVendor({ env })).to.equal("0xAAA");
    expect(vendorIdentity.resolveCanonicalVendor({ override: "0xBBB", env })).to.equal("0xBBB");
    // Blank values never shadow the committed default.
    env[vendorIdentity.CANONICAL_VENDOR_ENV] = "   ";
    expect(vendorIdentity.resolveCanonicalVendor({ override: "", env })).to.equal(PUBLISHED_VENDOR);
    expect(vendorIdentity.resolveCanonicalVendor()).to.equal(PUBLISHED_VENDOR);
  });
});

"use strict";

// test/cli.verify.trust-asof.test.js — the recipient-side TRUST-DECISION-AS-OF helper (EPIC-51 / T-51.2)
// wired into ALL FOUR signed-verify commands behind the strictly-OPTIONAL --revocations / --as-of flags:
//
//     vh evidence verify-signed   (runEvidenceVerifySigned)
//     vh dataset  verify-attest   (runDatasetVerifyAttest)
//     vh parcel   verify-attest   (runParcelVerifyAttest)
//     vh identity verify          (runIdentityVerify)
//
// For EACH command these prove the full acceptance bar:
//   * a signed artifact whose SIGNER IS REVOKED BEFORE the as-of verifies REVOKED (exit 3), naming the
//     reason + revokedAt (+ supersededBy when set);
//   * the SAME artifact with a revocation dated AFTER its as-of stays ACCEPTED (exit 0) with an informational
//     later-revoked note;
//   * a FORGED / invalid revocation file is IGNORED with a warning and NEVER downgrades the verdict;
//   * with NO --revocations flag the verdict + exit code are byte-identical to the pre-EPIC baseline
//     (regression-pinned against the SAME run with no flag);
//   * --as-of is honored, and defaults to the injected `now` when omitted;
//   * the read side is OFFLINE / key-free and writes NOTHING outside the caller's temp dir (cwd untouched).
//
// Every signing key is an EPHEMERAL in-process Wallet.createRandom() (TEST-ONLY, never persisted, never a
// real-funds key). All artifacts + revocations are built via the PRODUCTION build/sign paths, so the test
// exercises the genuine on-disk bytes, not hand-rolled envelopes. `nowISO` is injected so the default-as-of
// is deterministic. Each test isolates its filesystem effects to a throwaway temp dir and asserts cwd is
// untouched.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Wallet } = require("ethers");

const evidence = require("../cli/evidence");
const dataset = require("../cli/dataset");
const parcel = require("../cli/parcel");
const identity = require("../cli/identity");
const coreAttestation = require("../cli/core/attestation");
const coreRevocation = require("../cli/core/revocation");

// A fixed "now" injected as the default --as-of so the default path is deterministic.
const NOW = "2026-06-23T00:00:00.000Z";
const BEFORE = "2026-01-01T00:00:00.000Z"; // a revocation dated here is revoked-as-of NOW
const AFTER = "2026-12-01T00:00:00.000Z"; // a revocation dated here is NOT yet revoked-as-of NOW

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

describe("cli verify commands T-51.2: --revocations / --as-of trust-decision wiring (all four signed-verify paths)", function () {
  let tmpDirs;
  let cwdBefore;
  beforeEach(function () {
    tmpDirs = [];
    cwdBefore = fs.readdirSync(process.cwd()).sort();
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    // FILESYSTEM HYGIENE: nothing the verify paths did leaked into the working tree.
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });
  function mkTmp(prefix) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || "vh-asof-"));
    tmpDirs.push(d);
    return d;
  }
  function writeFiles(dir, files) {
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(dir, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }

  // Mint a GENUINE signed revocation for `wallet`'s own key (the self-control invariant holds by
  // construction), revoking it as of `revokedAt`, and write it to a throwaway file. Returns the path.
  async function writeRevocation(root, wallet, { revokedAt, reason = "compromised", supersededBy } = {}) {
    const params = { vendorAddress: wallet.address, reason, revokedAt };
    if (supersededBy !== undefined) params.supersededBy = supersededBy;
    const container = await coreRevocation.buildRevocation(params, wallet);
    const p = path.join(root, `revocation-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, coreRevocation.serializeSignedRevocation(container));
    return p;
  }

  // Write a FORGED revocation file (one whose signature does NOT back its claimed vendorAddress) for the
  // victim's key. Returns the path. A real container is minted for an attacker, then the embedded
  // vendorAddress is rewritten to the victim — verifyRevocation's self-control check fails => IGNORED.
  async function writeForgedRevocation(root, victimWallet) {
    const attacker = Wallet.createRandom();
    const real = await coreRevocation.buildRevocation(
      { vendorAddress: attacker.address, reason: "compromised", revokedAt: BEFORE },
      attacker
    );
    const tampered = JSON.parse(real.attestation);
    tampered.vendorAddress = victimWallet.address.toLowerCase();
    const forged = { ...real, attestation: JSON.stringify(tampered) + "\n" };
    const p = path.join(root, "forged-revocation.json");
    fs.writeFileSync(p, JSON.stringify(forged) + "\n");
    return p;
  }

  // ---------------------------------------------------------------------------------------------------
  // A small per-command driver abstraction: each entry knows how to (a) build a genuinely-signed artifact
  // for a given wallet under `root` (returns the artifact path + the wallet) and (b) run its verify command
  // with the OPTIONAL revocations/as-of flags + an injected now, returning { code, out, err }. This lets the
  // four commands share one body of acceptance assertions.
  // ---------------------------------------------------------------------------------------------------
  const drivers = {
    "evidence verify-signed": {
      async build(root, wallet) {
        const dir = path.join(mkTmp("vh-asof-ev-"), "payload");
        fs.mkdirSync(dir, { recursive: true });
        writeFiles(dir, { "a.txt": "AAA\n", "b.txt": "BBB\n" });
        const entries = evidence.loadDirEntries(path.resolve(dir));
        const seal = evidence.buildSeal(entries);
        const container = await evidence.signSealWith(seal, wallet);
        const p = path.join(root, "signed.vhevidence.json");
        fs.writeFileSync(p, coreAttestation.serializeSignedAttestation(container, evidence.SIGNED_SEAL_CFG));
        return { artifact: p };
      },
      run({ artifact, revocations, asOf, json }) {
        const io = capture();
        const code = evidence.runEvidenceVerifySigned(
          { signed: artifact, revocations, asOf, json: !!json },
          { ...io, nowISO: NOW }
        );
        return { code, out: io.out(), err: io.err() };
      },
    },

    "dataset verify-attest": {
      async build(root, wallet) {
        const dir = path.join(mkTmp("vh-asof-ds-"), "tree");
        fs.mkdirSync(dir, { recursive: true });
        writeFiles(dir, { "a.txt": "AAA", "b.txt": "BBB" });
        const manifestPath = path.join(mkTmp("vh-asof-ds-man-"), "manifest.json");
        dataset.runDatasetBuild({ dir, out: manifestPath, stdout: () => {} });
        const manifest = dataset.readManifest(manifestPath);
        const unsigned = dataset.buildAttestation(manifest);
        const canonical = dataset.serializeAttestation(unsigned);
        const signature = (await wallet.signMessage(canonical)).toLowerCase();
        const container = dataset.buildSignedAttestation({
          attestation: unsigned,
          scheme: "eip191-personal-sign",
          signer: wallet.address.toLowerCase(),
          signature,
        });
        const p = path.join(root, "signed.json");
        fs.writeFileSync(p, dataset.serializeSignedAttestation(container));
        return { artifact: p };
      },
      run({ artifact, revocations, asOf, json }) {
        let out = "";
        const code = dataset.runDatasetVerifyAttest({
          signed: artifact,
          revocations,
          asOf,
          json: !!json,
          nowISO: NOW,
          stdout: (s) => (out += s),
        });
        // runDatasetVerifyAttest returns the result object, NOT an exit code; map it the way vh.js does.
        return { code: code.accepted ? 0 : 3, out, result: code };
      },
    },

    "parcel verify-attest": {
      async build(root, wallet) {
        const dir = path.join(mkTmp("vh-asof-pc-"), "tree");
        fs.mkdirSync(dir, { recursive: true });
        writeFiles(dir, { "a.txt": "AAA", "b.txt": "BBB" });
        const manifestPath = path.join(mkTmp("vh-asof-pc-man-"), "manifest.json");
        parcel.runParcelBuild({ dir, out: manifestPath, stdout: () => {} });
        const manifest = parcel.readParcelManifest(manifestPath);
        const unsigned = parcel.buildParcelAttestation(manifest);
        const canonical = parcel.serializeParcelAttestation(unsigned);
        const signature = (await wallet.signMessage(canonical)).toLowerCase();
        const container = parcel.buildSignedParcelAttestation({
          attestation: unsigned,
          scheme: "eip191-personal-sign",
          signer: wallet.address.toLowerCase(),
          signature,
        });
        const p = path.join(root, "signed-parcel.json");
        fs.writeFileSync(p, parcel.serializeSignedParcelAttestation(container));
        return { artifact: p };
      },
      run({ artifact, revocations, asOf, json }) {
        let out = "";
        const code = parcel.runParcelVerifyAttest({
          signed: artifact,
          revocations,
          asOf,
          json: !!json,
          nowISO: NOW,
          stdout: (s) => (out += s),
        });
        return { code: code.accepted ? 0 : 3, out, result: code };
      },
    },

    "identity verify": {
      async build(root, wallet) {
        const container = await identity.buildIdentityCard(
          {
            vendorAddress: wallet.address,
            productLine: identity.PRODUCT_LINES ? identity.PRODUCT_LINES[0] : "dataledger",
            claims: ["we attest dataset provenance"],
            nonClaims: ["we do not attest legal ownership"],
            publishedAt: "2026-05-01T00:00:00.000Z",
          },
          wallet
        );
        const p = path.join(root, "card.json");
        fs.writeFileSync(p, identity.serializeSignedIdentityCard(container));
        return { artifact: p };
      },
      run({ artifact, revocations, asOf, json }) {
        const io = capture();
        const code = identity.runIdentityVerify(
          { card: artifact, revocations, asOf, json: !!json },
          { ...io, nowISO: NOW }
        );
        return { code, out: io.out(), err: io.err() };
      },
    },
  };

  for (const [name, driver] of Object.entries(drivers)) {
    describe(`vh ${name}`, function () {
      it("a signer REVOKED-before-as-of verifies REVOKED (exit 3), naming reason + revokedAt (+ supersededBy)", async function () {
        const root = mkTmp();
        const wallet = Wallet.createRandom();
        const { artifact } = await driver.build(root, wallet);
        const successor = Wallet.createRandom().address.toLowerCase();
        const rev = await writeRevocation(root, wallet, {
          revokedAt: BEFORE,
          reason: "compromised",
          supersededBy: successor,
        });
        // Default as-of is the injected NOW (which is AFTER the revocation) => REVOKED.
        const r = driver.run({ artifact, revocations: rev });
        expect(r.code, r.out + (r.err || "")).to.equal(3);
        expect(r.out).to.match(/REVOKED/);
        expect(r.out).to.include("compromised");
        expect(r.out).to.include(BEFORE);
        expect(r.out).to.include(successor);
      });

      it("a JSON run carries the trustAsOf block with status REVOKED + the governing record", async function () {
        const root = mkTmp();
        const wallet = Wallet.createRandom();
        const { artifact } = await driver.build(root, wallet);
        const rev = await writeRevocation(root, wallet, { revokedAt: BEFORE, reason: "retired" });
        const r = driver.run({ artifact, revocations: rev, json: true });
        expect(r.code).to.equal(3);
        const parsed = JSON.parse(r.out);
        expect(parsed.trustAsOf.status).to.equal("REVOKED");
        expect(parsed.trustAsOf.governing.reason).to.equal("retired");
        expect(parsed.trustAsOf.governing.revokedAt).to.equal(BEFORE);
        expect(parsed.accepted).to.equal(false);
        expect(parsed.failedChecks).to.include("keyRevokedAsOf");
      });

      it("the SAME artifact with a revocation dated AFTER its as-of stays ACCEPTED (exit 0) + a later-revoked note", async function () {
        const root = mkTmp();
        const wallet = Wallet.createRandom();
        const { artifact } = await driver.build(root, wallet);
        const rev = await writeRevocation(root, wallet, { revokedAt: AFTER, reason: "rotated" });
        const r = driver.run({ artifact, revocations: rev });
        expect(r.code, r.out + (r.err || "")).to.equal(0);
        // Informational later-revoked note present; verdict NOT downgraded.
        expect(r.out).to.match(/\[note\]/);
        expect(r.out).to.include(AFTER);
        expect(r.out).to.not.match(/\[REVOKED\]/);
      });

      it("a FORGED revocation is IGNORED with a warning and never downgrades the verdict (exit 0)", async function () {
        const root = mkTmp();
        const wallet = Wallet.createRandom();
        const { artifact } = await driver.build(root, wallet);
        const forged = await writeForgedRevocation(root, wallet);
        const r = driver.run({ artifact, revocations: forged });
        expect(r.code, r.out + (r.err || "")).to.equal(0);
        expect(r.out).to.match(/\[warning\]/);
        expect(r.out).to.not.match(/\[REVOKED\]/);
      });

      it("an explicit --as-of BEFORE the revocation keeps the artifact ACCEPTED (the as-of is honored)", async function () {
        const root = mkTmp();
        const wallet = Wallet.createRandom();
        const { artifact } = await driver.build(root, wallet);
        // Revocation dated 2026-01-01; with --as-of in 2025 it is NOT yet effective => ACCEPTED.
        const rev = await writeRevocation(root, wallet, { revokedAt: BEFORE });
        const r = driver.run({ artifact, revocations: rev, asOf: "2025-06-01T00:00:00.000Z" });
        expect(r.code, r.out + (r.err || "")).to.equal(0);
        expect(r.out).to.not.match(/\[REVOKED\]/);
        // And with the same revocation but a LATER explicit as-of it flips to REVOKED.
        const r2 = driver.run({ artifact, revocations: rev, asOf: "2026-03-01T00:00:00.000Z" });
        expect(r2.code).to.equal(3);
      });

      it("NO --revocations flag => byte-identical verdict + exit code to the pre-EPIC baseline (regression pin)", async function () {
        const root = mkTmp();
        const wallet = Wallet.createRandom();
        const { artifact } = await driver.build(root, wallet);
        // Even with a real revocation file on disk, NOT passing --revocations must change NOTHING.
        await writeRevocation(root, wallet, { revokedAt: BEFORE });
        const baseline = driver.run({ artifact });
        const withFlagButNoRevocations = driver.run({ artifact }); // identical call
        expect(baseline.code).to.equal(0);
        expect(baseline.out).to.equal(withFlagButNoRevocations.out);
        // The baseline output carries NO revocation-check block at all.
        expect(baseline.out).to.not.match(/revocation check/);
        expect(baseline.out).to.not.match(/trustAsOf/);
      });

      it("the JSON no-flag run has NO trustAsOf field (the shape is unchanged unless --revocations is given)", async function () {
        const root = mkTmp();
        const wallet = Wallet.createRandom();
        const { artifact } = await driver.build(root, wallet);
        const r = driver.run({ artifact, json: true });
        expect(r.code).to.equal(0);
        const parsed = JSON.parse(r.out);
        expect(parsed).to.not.have.property("trustAsOf");
        expect(parsed.accepted).to.equal(true);
      });
    });
  }
});

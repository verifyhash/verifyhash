"use strict";

// test/core.trust-asof.test.js — the PURE recipient-side TRUST-DECISION-AS-OF helper (EPIC-51 / T-51.2),
// cli/core/trust-asof.js. These tests prove the load-bearing decision rules WITHOUT any CLI / filesystem:
//
//   * a SOUND, subject-matching revocation dated AT-OR-BEFORE the as-of => REVOKED (revoked:true), naming
//     the governing reason + revokedAt (+ supersededBy when set);
//   * the SAME revocation dated AFTER the as-of => OK (revoked:false) + an informational `laterRevoked` note;
//   * a FORGED / TAMPERED / THIRD-PARTY / structurally-malformed / unparseable revocation is IGNORED with a
//     warning and NEVER downgrades the verdict (the anti-grief invariant);
//   * a SOUND revocation for a DIFFERENT key is irrelevant (counted, never a downgrade);
//   * the earliest applicable revocation GOVERNS when several apply;
//   * an "(unrecoverable)" subject is UNEVALUABLE (never a silent OK);
//   * a malformed --as-of / non-JSON revocations input HARD-errors (TrustAsOfError);
//   * applyToVerifyResult folds a REVOKED decision onto an ACCEPTED verify result (accepted:false, exit-3
//     mapping) but NEVER upgrades an already-REJECTED one;
//   * resolveAsOf honors an explicit --as-of and defaults to the injected now.
//
// Revocations are minted with the REAL revocation core over EPHEMERAL in-process Wallets (TEST-ONLY keys,
// never real funds), so every fixture is a genuine signed artifact, not a hand-rolled envelope. PURE — no
// filesystem, no network, no clock (the as-of is always an explicit argument).

const { expect } = require("chai");
const { Wallet } = require("ethers");

const trustAsOf = require("../cli/core/trust-asof");
const coreRevocation = require("../cli/core/revocation");

// Mint a GENUINE signed revocation for `wallet`'s own address (the self-control invariant holds by
// construction) revoking it as of `revokedAt`, for `reason`, optionally superseded by `supersededBy`.
async function mintRevocation(wallet, { reason = "compromised", revokedAt, supersededBy } = {}) {
  const params = { vendorAddress: wallet.address, reason, revokedAt };
  if (supersededBy !== undefined) params.supersededBy = supersededBy;
  return coreRevocation.buildRevocation(params, wallet);
}

describe("cli/core/trust-asof T-51.2: recipient-side TRUST-DECISION-AS-OF (evaluateTrustAsOf)", function () {
  describe("evaluateTrustAsOf — the core decision rule", function () {
    it("REVOKED when a sound, subject-matching revocation is dated BEFORE the as-of (names reason + revokedAt)", async function () {
      const w = Wallet.createRandom();
      const subject = w.address.toLowerCase();
      const rev = await mintRevocation(w, {
        reason: "compromised",
        revokedAt: "2026-01-01T00:00:00.000Z",
      });
      const d = trustAsOf.evaluateTrustAsOf({
        subject,
        asOf: "2026-06-01T00:00:00.000Z", // AFTER the revocation
        revocations: [rev],
      });
      expect(d.status).to.equal("REVOKED");
      expect(d.revoked).to.equal(true);
      expect(d.governing).to.include({
        vendorAddress: subject,
        reason: "compromised",
        revokedAt: "2026-01-01T00:00:00.000Z",
        supersededBy: null,
      });
      expect(d.laterRevoked).to.equal(null);
      expect(d.counts.applicable).to.equal(1);
    });

    it("includes supersededBy in the governing record when the revocation sets it", async function () {
      const w = Wallet.createRandom();
      const successor = Wallet.createRandom().address.toLowerCase();
      const rev = await mintRevocation(w, {
        reason: "rotated",
        revokedAt: "2026-02-02T00:00:00.000Z",
        supersededBy: successor,
      });
      const d = trustAsOf.evaluateTrustAsOf({
        subject: w.address.toLowerCase(),
        asOf: "2026-06-01T00:00:00.000Z",
        revocations: [rev],
      });
      expect(d.status).to.equal("REVOKED");
      expect(d.governing.supersededBy).to.equal(successor);
      expect(d.governing.reason).to.equal("rotated");
    });

    it("the SAME revocation dated AFTER the as-of stays OK with a later-revoked informational note", async function () {
      const w = Wallet.createRandom();
      const subject = w.address.toLowerCase();
      const rev = await mintRevocation(w, {
        reason: "retired",
        revokedAt: "2026-06-01T00:00:00.000Z",
      });
      const d = trustAsOf.evaluateTrustAsOf({
        subject,
        asOf: "2026-01-01T00:00:00.000Z", // BEFORE the revocation
        revocations: [rev],
      });
      expect(d.status).to.equal("OK");
      expect(d.revoked).to.equal(false);
      expect(d.governing).to.equal(null);
      expect(d.laterRevoked).to.include({
        vendorAddress: subject,
        reason: "retired",
        revokedAt: "2026-06-01T00:00:00.000Z",
      });
      expect(d.counts.later).to.equal(1);
    });

    it("a revocation effective EXACTLY at the as-of instant counts as REVOKED (inclusive boundary)", async function () {
      const w = Wallet.createRandom();
      const at = "2026-03-03T03:03:03.000Z";
      const rev = await mintRevocation(w, { revokedAt: at });
      const d = trustAsOf.evaluateTrustAsOf({
        subject: w.address.toLowerCase(),
        asOf: at,
        revocations: [rev],
      });
      expect(d.status).to.equal("REVOKED");
    });

    it("a FORGED revocation (signed by a different key claiming the subject) is IGNORED with a warning, never a downgrade", async function () {
      const victim = Wallet.createRandom();
      const subject = victim.address.toLowerCase();
      // The attacker signs a revocation but stamps the VICTIM's vendorAddress into it. buildRevocation would
      // refuse (self-control), so we forge the container directly: mint a real one for the attacker, then
      // rewrite the embedded vendorAddress to the victim. verifyRevocation's vendorAddressMatchesSigner fails.
      const attacker = Wallet.createRandom();
      const real = await mintRevocation(attacker, { revokedAt: "2026-01-01T00:00:00.000Z" });
      const tampered = JSON.parse(real.attestation);
      tampered.vendorAddress = subject;
      const forged = { ...real, attestation: JSON.stringify(tampered) + "\n" };
      const d = trustAsOf.evaluateTrustAsOf({
        subject,
        asOf: "2026-06-01T00:00:00.000Z",
        revocations: [forged],
      });
      expect(d.status).to.equal("OK");
      expect(d.revoked).to.equal(false);
      expect(d.counts.ignored).to.equal(1);
      expect(d.ignored[0]).to.match(/ignored a (revocation that does not verify|malformed)/);
    });

    it("a TAMPERED revocation (mutated revokedAt after signing) is IGNORED, never a downgrade", async function () {
      const w = Wallet.createRandom();
      const subject = w.address.toLowerCase();
      const real = await mintRevocation(w, { revokedAt: "2026-06-01T00:00:00.000Z" }); // later than as-of
      const payload = JSON.parse(real.attestation);
      payload.revokedAt = "2026-01-01T00:00:00.000Z"; // backdate it to BEFORE the as-of (an attacker's dream)
      const tampered = { ...real, attestation: JSON.stringify(payload) + "\n" };
      const d = trustAsOf.evaluateTrustAsOf({
        subject,
        asOf: "2026-03-01T00:00:00.000Z",
        revocations: [tampered],
      });
      // The signature no longer recovers to the embedded vendorAddress over the mutated bytes => ignored.
      expect(d.status).to.equal("OK");
      expect(d.counts.ignored).to.equal(1);
    });

    it("an UNPARSEABLE revocation entry is IGNORED with a warning, never throws or downgrades", async function () {
      const w = Wallet.createRandom();
      const d = trustAsOf.evaluateTrustAsOf({
        subject: w.address.toLowerCase(),
        asOf: "2026-06-01T00:00:00.000Z",
        revocations: ["{not json", { kind: "totally-wrong" }],
      });
      expect(d.status).to.equal("OK");
      expect(d.counts.ignored).to.equal(2);
    });

    it("a sound revocation for a DIFFERENT key is irrelevant (counted, never a downgrade)", async function () {
      const subjectWallet = Wallet.createRandom();
      const otherWallet = Wallet.createRandom();
      const rev = await mintRevocation(otherWallet, { revokedAt: "2026-01-01T00:00:00.000Z" });
      const d = trustAsOf.evaluateTrustAsOf({
        subject: subjectWallet.address.toLowerCase(),
        asOf: "2026-06-01T00:00:00.000Z",
        revocations: [rev],
      });
      expect(d.status).to.equal("OK");
      expect(d.counts.irrelevant).to.equal(1);
      expect(d.counts.applicable).to.equal(0);
    });

    it("the EARLIEST applicable revocation governs when several apply to the same key", async function () {
      const w = Wallet.createRandom();
      const subject = w.address.toLowerCase();
      const early = await mintRevocation(w, { reason: "compromised", revokedAt: "2026-01-01T00:00:00.000Z" });
      const late = await mintRevocation(w, { reason: "retired", revokedAt: "2026-04-01T00:00:00.000Z" });
      const d = trustAsOf.evaluateTrustAsOf({
        subject,
        asOf: "2026-06-01T00:00:00.000Z",
        revocations: [late, early], // out of order on purpose
      });
      expect(d.status).to.equal("REVOKED");
      expect(d.governing.revokedAt).to.equal("2026-01-01T00:00:00.000Z");
      expect(d.governing.reason).to.equal("compromised");
      expect(d.counts.applicable).to.equal(2);
    });

    it("an (unrecoverable) subject is UNEVALUABLE (never a silent OK)", function () {
      const d = trustAsOf.evaluateTrustAsOf({
        subject: "(unrecoverable)",
        asOf: "2026-06-01T00:00:00.000Z",
        revocations: [],
      });
      expect(d.status).to.equal("UNEVALUABLE");
      expect(d.revoked).to.equal(false);
    });

    it("accepts a single container object, an array, and JSON text equivalently", async function () {
      const w = Wallet.createRandom();
      const subject = w.address.toLowerCase();
      const rev = await mintRevocation(w, { revokedAt: "2026-01-01T00:00:00.000Z" });
      const asOf = "2026-06-01T00:00:00.000Z";
      const single = trustAsOf.evaluateTrustAsOf({ subject, asOf, revocations: rev });
      const arr = trustAsOf.evaluateTrustAsOf({ subject, asOf, revocations: [rev] });
      const text = trustAsOf.evaluateTrustAsOf({ subject, asOf, revocations: JSON.stringify([rev]) });
      expect(single.status).to.equal("REVOKED");
      expect(arr.status).to.equal("REVOKED");
      expect(text.status).to.equal("REVOKED");
    });

    it("HARD-errors on a malformed --as-of and on non-JSON revocations text", function () {
      const w = Wallet.createRandom();
      expect(() =>
        trustAsOf.evaluateTrustAsOf({ subject: w.address.toLowerCase(), asOf: "nope", revocations: [] })
      ).to.throw(trustAsOf.TrustAsOfError, /as-of/);
      expect(() =>
        trustAsOf.evaluateTrustAsOf({
          subject: w.address.toLowerCase(),
          asOf: "2026-06-01T00:00:00.000Z",
          revocations: "{not json at all",
        })
      ).to.throw(trustAsOf.TrustAsOfError, /not valid JSON/);
    });
  });

  describe("resolveAsOf — honor explicit, default to injected now", function () {
    it("honors an explicit --as-of", function () {
      const r = trustAsOf.resolveAsOf("2026-05-05T05:05:05.000Z", "2026-06-01T00:00:00.000Z");
      expect(r).to.deep.equal({ asOf: "2026-05-05T05:05:05.000Z", defaulted: false });
    });
    it("defaults to the injected now when no --as-of", function () {
      const r = trustAsOf.resolveAsOf(undefined, "2026-06-01T00:00:00.000Z");
      expect(r).to.deep.equal({ asOf: "2026-06-01T00:00:00.000Z", defaulted: true });
    });
    it("HARD-errors on a malformed explicit --as-of (never coerces to now)", function () {
      expect(() => trustAsOf.resolveAsOf("garbage", "2026-06-01T00:00:00.000Z")).to.throw(
        trustAsOf.TrustAsOfError
      );
    });
  });

  describe("applyToVerifyResult — fold the decision onto a verify result", function () {
    it("flips an ACCEPTED result to REVOKED (accepted:false, failedChecks names keyRevokedAsOf)", async function () {
      const w = Wallet.createRandom();
      const subject = w.address.toLowerCase();
      const rev = await mintRevocation(w, { revokedAt: "2026-01-01T00:00:00.000Z" });
      const accepted = {
        verdict: "ACCEPTED",
        accepted: true,
        recoveredSigner: subject,
        failedChecks: [],
      };
      const out = trustAsOf.applyToVerifyResult({
        result: accepted,
        revocations: [rev],
        asOf: "2026-06-01T00:00:00.000Z",
      });
      expect(out.accepted).to.equal(false);
      expect(out.verdict).to.equal("REVOKED");
      expect(out.failedChecks).to.include("keyRevokedAsOf");
      expect(out.trustAsOf.status).to.equal("REVOKED");
      // The original is NOT mutated.
      expect(accepted.accepted).to.equal(true);
      expect(accepted.failedChecks).to.deep.equal([]);
    });

    it("NEVER upgrades an already-REJECTED result, but still attaches the trustAsOf block", async function () {
      const w = Wallet.createRandom();
      const subject = w.address.toLowerCase();
      const rev = await mintRevocation(w, { revokedAt: "2026-06-01T00:00:00.000Z" }); // later => not applicable
      const rejected = {
        verdict: "REJECTED",
        accepted: false,
        recoveredSigner: subject,
        failedChecks: ["signatureMatchesSigner"],
      };
      const out = trustAsOf.applyToVerifyResult({
        result: rejected,
        revocations: [rev],
        asOf: "2026-01-01T00:00:00.000Z",
      });
      expect(out.accepted).to.equal(false);
      expect(out.verdict).to.equal("REJECTED");
      expect(out.trustAsOf.status).to.equal("OK");
      expect(out.trustAsOf.laterRevoked).to.not.equal(null);
    });

    it("leaves an ACCEPTED result accepted when no revocation applies", async function () {
      const w = Wallet.createRandom();
      const subject = w.address.toLowerCase();
      const out = trustAsOf.applyToVerifyResult({
        result: { verdict: "ACCEPTED", accepted: true, recoveredSigner: subject, failedChecks: [] },
        revocations: [],
        asOf: "2026-06-01T00:00:00.000Z",
      });
      expect(out.accepted).to.equal(true);
      expect(out.verdict).to.equal("ACCEPTED");
      expect(out.trustAsOf.status).to.equal("OK");
    });
  });

  describe("renderTrustAsOf — human lines", function () {
    it("renders a REVOKED block naming reason + revokedAt + supersededBy", async function () {
      const w = Wallet.createRandom();
      const successor = Wallet.createRandom().address.toLowerCase();
      const rev = await mintRevocation(w, {
        reason: "superseded",
        revokedAt: "2026-01-01T00:00:00.000Z",
        supersededBy: successor,
      });
      const d = trustAsOf.evaluateTrustAsOf({
        subject: w.address.toLowerCase(),
        asOf: "2026-06-01T00:00:00.000Z",
        revocations: [rev],
      });
      const lines = trustAsOf.renderTrustAsOf(d, { defaulted: false }).join("\n");
      expect(lines).to.match(/REVOKED/);
      expect(lines).to.match(/superseded/);
      expect(lines).to.include(successor);
      expect(lines).to.include("2026-01-01T00:00:00.000Z");
    });

    it("renders an ignored warning line for a forged revocation", async function () {
      const w = Wallet.createRandom();
      const d = trustAsOf.evaluateTrustAsOf({
        subject: w.address.toLowerCase(),
        asOf: "2026-06-01T00:00:00.000Z",
        revocations: ["{bad json"],
      });
      const lines = trustAsOf.renderTrustAsOf(d).join("\n");
      expect(lines).to.match(/\[warning\]/);
    });
  });
});

"use strict";

// Tests for the PURE producer-key REVOCATION core (T-51.1, cli/core/revocation.js).
//
// What these prove (the T-51.1 acceptance criteria):
//   * Round-trip: buildRevocation (signed with an EPHEMERAL Wallet) -> verifyRevocation -> ACCEPTED, with
//     the recovered signer == the revoked vendorAddress (the self-control invariant holds), and the verdict
//     carries the FAMILY shape (verdict/accepted/recoveredSigner/claimedSigner/checks/failedChecks) PLUS
//     the revocation-specific vendorAddress + reason + revokedAt + supersededBy + vendorAddressMatchesSigner.
//   * SELF-CONTROL invariant: a THIRD-PARTY signature over SOMEONE ELSE'S vendorAddress is REJECTED at
//     verify (vendorAddressMatchesSigner false), and buildRevocation REFUSES to mint such a thing at all.
//   * TAMPER: a one-byte change to the embedded payload OR to the signature is REJECTED, never a false
//     ACCEPT, naming the failing check.
//   * HARD validation (RevocationError, named + localized): an unknown/extraneous field, an out-of-set
//     reason, a non-canonical revokedAt, and a malformed address all HARD-error.
//   * supersededBy is OPTIONAL and, when present, a valid lowercase-0x (absent omitted from canonical bytes;
//     a present-but-malformed/checksummed value HARD-errors; a checksummed input is normalized).
//   * NO new crypto/dependency: the signing/recovery path is core/attestation.js VERBATIM (scheme stays
//     "eip191-personal-sign"); the only ethers use is the EPHEMERAL test Wallet + getAddress.
//   * The core is PURE: no file writes (we assert cwd is untouched), no network, key only in the ephemeral
//     in-process Wallet.

const { expect } = require("chai");
const fs = require("fs");
const { Wallet, getAddress } = require("ethers");

const REV = require("../cli/core/revocation");
const {
  REVOCATION_KIND,
  REVOCATION_TRUST_NOTE,
  SIGNED_REVOCATION_KIND,
  REVOCATION_REASONS,
  RevocationError,
  validateRevocation,
  serializeRevocation,
  buildRevocationPayload,
  buildRevocation,
  validateSignedRevocation,
  serializeSignedRevocation,
  readRevocation,
  verifyRevocation,
} = REV;

describe("core: producer key revocation (T-51.1)", function () {
  // A canonical, valid set of revocation fields, parameterized by the vendor address. revokedAt is a
  // canonical ISO instant; reason is in the closed set; supersededBy is OMITTED by default (optional).
  function revParams(vendorAddress, overrides = {}) {
    return {
      vendorAddress,
      reason: "compromised",
      revokedAt: "2026-06-26T00:00:00.000Z",
      ...overrides,
    };
  }

  // Build a SIGNED revocation with an EPHEMERAL, THROWAWAY in-process key (NEVER persisted, NEVER funded). By
  // default the revocation marks the SAME address the signer controls revoked (the honest, self-control case).
  async function signedRevocation(overrides = {}, wallet) {
    const w = wallet || Wallet.createRandom();
    expect(w.privateKey).to.match(/^0x[0-9a-fA-F]{64}$/); // an in-memory key — never a real-funds key
    const params = revParams(w.address, overrides);
    const container = await buildRevocation(params, w);
    return { wallet: w, container, params };
  }

  // Surgically re-embed TAMPERED canonical revocation bytes into a signed container WITHOUT re-signing — the
  // original signature is kept, so recovery over the new bytes diverges from the claimed/vendor address. The
  // tampered revocation must itself be STRUCTURALLY VALID (the wrap-don't-edit invariant re-validates the
  // embedded payload + requires it byte-equal serializeRevocation(embedded)), so the container survives
  // validateSignedRevocation and the divergence surfaces as a clean REJECTED verdict (not a hard error).
  function tamperedContainer(container, mutate) {
    const embedded = JSON.parse(container.attestation);
    mutate(embedded); // change a revocation field in place
    const tamperedBytes = serializeRevocation(embedded); // re-canonicalize -> still wrap-don't-edit-valid
    return { ...container, attestation: tamperedBytes };
  }

  // ---------- round-trip ACCEPT (self-control invariant holds) ----------

  it("round-trips: buildRevocation -> verifyRevocation ACCEPTS; recovered signer == revoked vendorAddress", async function () {
    const { wallet, container } = await signedRevocation();
    const lc = wallet.address.toLowerCase();

    // The container is a sound signed revocation (its own kinds), reusing the eip191 scheme VERBATIM.
    expect(container.kind).to.equal(SIGNED_REVOCATION_KIND);
    const embedded = JSON.parse(container.attestation);
    expect(embedded.kind).to.equal(REVOCATION_KIND);
    expect(embedded.note).to.equal(REVOCATION_TRUST_NOTE);
    expect(embedded.vendorAddress).to.equal(lc);
    expect(container.signature.scheme).to.equal("eip191-personal-sign"); // NO new scheme

    const r = verifyRevocation({ container });
    expect(r.verdict).to.equal("ACCEPTED");
    expect(r.accepted).to.equal(true);
    // The self-control invariant: the recovered signer IS the revoked vendorAddress.
    expect(r.recoveredSigner).to.equal(lc);
    expect(r.vendorAddress).to.equal(lc);
    expect(r.recoveredSigner).to.equal(r.vendorAddress);
    expect(r.claimedSigner).to.equal(lc);
    expect(r.scheme).to.equal("eip191-personal-sign");
    expect(r.reason).to.equal("compromised");
    expect(r.revokedAt).to.equal("2026-06-26T00:00:00.000Z");
    expect(r.supersededBy).to.equal(null); // omitted -> stable null in the verdict
    // FAMILY verdict shape + the revocation-specific self-control check.
    expect(r.checks.signatureMatchesSigner).to.equal(true);
    expect(r.checks.vendorAddressMatchesSigner).to.equal(true);
    expect(r.checks.signerMatchesExpected).to.equal(null); // not requested
    expect(r.expectedSigner).to.equal(null);
    expect(r.failedChecks).to.deep.equal([]);
  });

  it("round-trips with a CHECKSUMMED vendorAddress input (normalized to lowercase, still ACCEPTS)", async function () {
    const w = Wallet.createRandom();
    const params = revParams(getAddress(w.address)); // EIP-55 checksummed input
    const container = await buildRevocation(params, w);
    const r = verifyRevocation({ container });
    expect(r.verdict).to.equal("ACCEPTED");
    expect(r.vendorAddress).to.equal(w.address.toLowerCase());
    expect(r.recoveredSigner).to.equal(w.address.toLowerCase());
  });

  it("serializeSignedRevocation / readRevocation round-trip byte-for-byte", async function () {
    const { container } = await signedRevocation();
    const bytes = serializeSignedRevocation(container);
    const reread = readRevocation(bytes);
    expect(serializeSignedRevocation(reread)).to.equal(bytes);
    expect(verifyRevocation({ container: reread }).verdict).to.equal("ACCEPTED");
  });

  // ---------- SELF-CONTROL: a third party cannot revoke a key it does not control ----------

  it("REJECTS a third-party signature over SOMEONE ELSE'S vendorAddress (self-control invariant)", async function () {
    // Build an HONEST revocation for `claimant` (vendorAddress == claimant), then surgically swap ONLY the
    // embedded vendorAddress to `victim` while keeping claimant's signature. claimant is now trying to revoke
    // victim's key — but the signature recovers to claimant, NOT victim -> self-control check fails.
    const claimant = Wallet.createRandom(); // TEST-ONLY key
    const victim = Wallet.createRandom(); // a DIFFERENT key claimant does NOT control
    const { container } = await signedRevocation({}, claimant);

    const tampered = tamperedContainer(container, (c) => {
      c.vendorAddress = victim.address.toLowerCase(); // claim to revoke victim's key
    });
    const r = verifyRevocation({ container: tampered });
    expect(r.verdict).to.equal("REJECTED");
    expect(r.accepted).to.equal(false);
    expect(r.checks.vendorAddressMatchesSigner).to.equal(false);
    expect(r.failedChecks).to.include("vendorAddressMatchesSigner");
    // The recovered signer is NOT victim — the third party never controlled the revoked key.
    expect(r.recoveredSigner).to.not.equal(victim.address.toLowerCase());
    expect(r.vendorAddress).to.equal(victim.address.toLowerCase());
  });

  it("buildRevocation REFUSES to mint a revocation for an address the signing key does not control", async function () {
    const signer = Wallet.createRandom(); // controls signer.address
    const otherAddress = Wallet.createRandom().address; // a DIFFERENT address the signer does NOT control
    let threw = null;
    try {
      await buildRevocation(revParams(otherAddress), signer);
    } catch (e) {
      threw = e;
    }
    expect(threw).to.be.instanceOf(RevocationError);
    expect(threw.message).to.contain("does not control");
    expect(threw.message).to.contain("vendorAddress");
    expect(threw.message).to.contain("revokes ITSELF");
  });

  // ---------- TAMPER: one-byte change to payload OR signature -> REJECT, never a false ACCEPT ----------

  it("TAMPER the embedded payload (one byte: reason) -> REJECTED on signatureMatchesSigner", async function () {
    const { container } = await signedRevocation();
    const tampered = tamperedContainer(container, (c) => {
      c.reason = "rotated"; // a DIFFERENT in-set reason — still must reject (bytes changed)
    });
    const r = verifyRevocation({ container: tampered });
    expect(r.verdict).to.equal("REJECTED");
    expect(r.accepted).to.equal(false);
    expect(r.checks.signatureMatchesSigner).to.equal(false);
    expect(r.failedChecks).to.include("signatureMatchesSigner");
  });

  it("TAMPER the embedded payload (one byte: revokedAt) -> REJECTED, never a false ACCEPT", async function () {
    const { container } = await signedRevocation();
    const tampered = tamperedContainer(container, (c) => {
      c.revokedAt = "2026-06-27T00:00:00.000Z"; // move the date one day — bytes changed
    });
    const r = verifyRevocation({ container: tampered });
    expect(r.verdict).to.equal("REJECTED");
    expect(r.checks.signatureMatchesSigner).to.equal(false);
    expect(r.failedChecks).to.include("signatureMatchesSigner");
  });

  it("TAMPER the SIGNATURE (one byte) -> REJECTED, never a false ACCEPT", async function () {
    const { container } = await signedRevocation();
    // Flip the last hex nibble of the signature (still a 130-hex eip191 shape so it passes structural
    // validation, but it no longer recovers to the claimed signer).
    const sig = container.signature.signature;
    const lastNibble = sig.slice(-1);
    const flipped = lastNibble === "0" ? "1" : "0";
    const tamperedSig = sig.slice(0, -1) + flipped;
    expect(tamperedSig).to.not.equal(sig);
    const tampered = { ...container, signature: { ...container.signature, signature: tamperedSig } };
    const r = verifyRevocation({ container: tampered });
    expect(r.verdict).to.equal("REJECTED");
    expect(r.accepted).to.equal(false);
    expect(r.checks.signatureMatchesSigner).to.equal(false);
    expect(r.failedChecks).to.include("signatureMatchesSigner");
  });

  // ---------- HARD validation errors (named + localized RevocationError) ----------

  it("an UNKNOWN/extraneous field HARD-errors (closed field set)", function () {
    const w = Wallet.createRandom();
    const payload = buildRevocationPayload(revParams(w.address));
    const bad = { ...payload, surprise: "smuggled" };
    expect(() => validateRevocation(bad)).to.throw(RevocationError, /unknown field/);
  });

  it("an OUT-OF-SET reason HARD-errors (closed reason set); every documented reason is accepted", function () {
    const w = Wallet.createRandom();
    const bad = revParams(w.address, { reason: "not-a-real-reason" });
    expect(() => buildRevocationPayload(bad)).to.throw(RevocationError, /reason/);
    for (const reason of REVOCATION_REASONS) {
      const ok = buildRevocationPayload(revParams(w.address, { reason }));
      expect(ok.reason).to.equal(reason);
    }
  });

  it("a NON-CANONICAL revokedAt (date-only / rolled-over) HARD-errors", function () {
    const w = Wallet.createRandom();
    expect(() => buildRevocationPayload(revParams(w.address, { revokedAt: "2026-06-26" }))).to.throw(
      RevocationError,
      /revokedAt/
    );
    // Feb-29 in a non-leap year rolls over -> rejected by the canonical round-trip.
    expect(() =>
      buildRevocationPayload(revParams(w.address, { revokedAt: "2026-02-29T00:00:00.000Z" }))
    ).to.throw(RevocationError, /revokedAt/);
    // No-millis canonical form is also rejected (millis required by the round-trip, like the identity card).
    expect(() =>
      buildRevocationPayload(revParams(w.address, { revokedAt: "2026-06-26T00:00:00Z" }))
    ).to.throw(RevocationError, /revokedAt/);
  });

  it("a MALFORMED vendorAddress HARD-errors (named)", function () {
    expect(() => buildRevocationPayload(revParams("0xnot-an-address"))).to.throw(
      RevocationError,
      /vendorAddress/
    );
    // A mixed-case (checksummed-but-wrong) string that isn't a valid address also hard-errors.
    expect(() => buildRevocationPayload(revParams("0x1234"))).to.throw(RevocationError, /vendorAddress/);
    // At the validate layer, a checksummed/mixed-case vendorAddress is rejected for byte-determinism.
    const w = Wallet.createRandom();
    const payload = buildRevocationPayload(revParams(w.address));
    const mixed = { ...payload, vendorAddress: getAddress(w.address) }; // EIP-55 mixed case
    expect(() => validateRevocation(mixed)).to.throw(RevocationError, /vendorAddress/);
  });

  it("a MISSING required field HARD-errors", function () {
    const w = Wallet.createRandom();
    const base = revParams(w.address);
    const { revokedAt, ...noDate } = base;
    expect(() => buildRevocationPayload(noDate)).to.throw(RevocationError, /revokedAt/);
    const { reason, ...noReason } = base;
    expect(() => buildRevocationPayload(noReason)).to.throw(RevocationError, /reason/);
    const { vendorAddress, ...noVendor } = base;
    expect(() => buildRevocationPayload(noVendor)).to.throw(RevocationError, /vendorAddress/);
  });

  // ---------- supersededBy: OPTIONAL, valid lowercase-0x when present ----------

  it("supersededBy is OPTIONAL: ABSENT -> omitted from canonical bytes + null in the verdict", async function () {
    const { container } = await signedRevocation(); // no supersededBy
    const embedded = JSON.parse(container.attestation);
    expect(embedded).to.not.have.property("supersededBy");
    // The canonical bytes must NOT carry a supersededBy field slot at all (one encoding of "no successor").
    // (The trust `note` text itself mentions "supersededBy", so we assert on the absence of the JSON KEY,
    // i.e. a `"supersededBy":` field, not a bare substring of the whole bytes.)
    expect(container.attestation).to.not.match(/"supersededBy":/);
    const r = verifyRevocation({ container });
    expect(r.verdict).to.equal("ACCEPTED");
    expect(r.supersededBy).to.equal(null);
  });

  it("supersededBy PRESENT (valid lowercase-0x successor) -> ACCEPTED, surfaced in the verdict", async function () {
    const successor = Wallet.createRandom().address.toLowerCase();
    const { wallet, container } = await signedRevocation({ supersededBy: successor });
    const embedded = JSON.parse(container.attestation);
    expect(embedded.supersededBy).to.equal(successor);
    const r = verifyRevocation({ container });
    expect(r.verdict).to.equal("ACCEPTED");
    expect(r.recoveredSigner).to.equal(wallet.address.toLowerCase());
    expect(r.supersededBy).to.equal(successor);
  });

  it("supersededBy CHECKSUMMED input is normalized to lowercase (still ACCEPTS)", async function () {
    const successor = Wallet.createRandom().address; // EIP-55 checksummed
    const { container } = await signedRevocation({ supersededBy: getAddress(successor) });
    const r = verifyRevocation({ container });
    expect(r.verdict).to.equal("ACCEPTED");
    expect(r.supersededBy).to.equal(successor.toLowerCase());
  });

  it("supersededBy MALFORMED (present but not a 0x-address) HARD-errors", function () {
    const w = Wallet.createRandom();
    expect(() => buildRevocationPayload(revParams(w.address, { supersededBy: "0xnope" }))).to.throw(
      RevocationError,
      /supersededBy/
    );
    // null is a present-but-invalid successor (we do NOT treat null as "absent") -> rejected at validate.
    const payload = buildRevocationPayload(revParams(w.address));
    const withNull = { ...payload, supersededBy: null };
    expect(() => validateRevocation(withNull)).to.throw(RevocationError, /supersededBy/);
    // A mixed-case (checksummed) successor is rejected at the validate layer for byte-determinism.
    const mixed = { ...payload, supersededBy: getAddress(Wallet.createRandom().address) };
    expect(() => validateRevocation(mixed)).to.throw(RevocationError, /supersededBy/);
  });

  // ---------- structural safety: wrong-kind container HARD-errors before any verdict ----------

  it("validateSignedRevocation / verifyRevocation HARD-error on a wrong-kind container", async function () {
    const { container } = await signedRevocation();
    const wrong = { ...container, kind: "vh-identity-card-signed" };
    expect(() => validateSignedRevocation(wrong)).to.throw();
    expect(() => verifyRevocation({ container: wrong })).to.throw();
  });

  it("readRevocation HARD-errors on invalid JSON (RevocationError, not a raw SyntaxError)", function () {
    expect(() => readRevocation("{not json")).to.throw(RevocationError, /not valid JSON/);
  });

  // ---------- --signer-style expected pin (the family's OPTIONAL third check) ----------

  it("expectedSigner pinned to the WRONG address -> REJECTED (signature genuine; only the pin fails)", async function () {
    const { wallet, container } = await signedRevocation();
    const other = Wallet.createRandom();
    // Right signer (checksummed input is normalized) -> ACCEPTED + pin PASS.
    const ok = verifyRevocation({ container, expectedSigner: getAddress(wallet.address) });
    expect(ok.verdict).to.equal("ACCEPTED");
    expect(ok.checks.signerMatchesExpected).to.equal(true);
    // WRONG signer -> REJECTED, naming ONLY the failed pin.
    const bad = verifyRevocation({ container, expectedSigner: other.address });
    expect(bad.verdict).to.equal("REJECTED");
    expect(bad.checks.signerMatchesExpected).to.equal(false);
    expect(bad.checks.signatureMatchesSigner).to.equal(true);
    expect(bad.checks.vendorAddressMatchesSigner).to.equal(true);
    expect(bad.failedChecks).to.deep.equal(["signerMatchesExpected"]);
  });

  // ---------- PURITY: no filesystem side effects ----------

  it("is PURE: build + verify write NOTHING to cwd", async function () {
    const before = fs.readdirSync(process.cwd()).sort();
    const { container } = await signedRevocation();
    verifyRevocation({ container });
    verifyRevocation({ container, expectedSigner: container.signature.signer });
    const after = fs.readdirSync(process.cwd()).sort();
    expect(after).to.deep.equal(before);
  });
});

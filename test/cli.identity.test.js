"use strict";

// Tests for the PURE producer-IDENTITY core (T-49.1, cli/identity.js).
//
// What these prove:
//   * Round-trip: buildIdentityCard (signed with an EPHEMERAL Wallet) -> verifyIdentityCard -> ACCEPTED,
//     and the verdict carries the FAMILY shape (verdict/accepted/recoveredSigner/claimedSigner/checks/
//     failedChecks) PLUS the identity-specific vendorAddress + vendorAddressMatchesSigner check.
//   * Every TAMPER of the embedded card (claims / nonClaims / vendorAddress / productLine) keeps the
//     ORIGINAL signature, so the signature recovers to a DIFFERENT address than the (now-changed) bytes
//     imply -> REJECTED, naming the failing check (signatureMatchesSigner and, for a vendorAddress edit,
//     vendorAddressMatchesSigner). NEVER a false ACCEPT.
//   * A card whose vendorAddress != the recovering signer (built honestly for one key, but asserting
//     another address) is REJECTED at verify and REFUSED at mint.
//   * The closed-field / closed-productLine / non-empty-claims/nonClaims validation HARD-errors
//     (IdentityCardError) on every violation, never half-accepting.
//   * --signer pinned to the WRONG address -> REJECTED (the signature is genuine; only the pin fails).
//   * The core is PURE: no file writes (we assert cwd is untouched), no network, key only in the
//     ephemeral in-process Wallet.

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const { Wallet, getAddress } = require("ethers");

const ID = require("../cli/identity");
const {
  IDENTITY_CARD_KIND,
  IDENTITY_CARD_TRUST_NOTE,
  SIGNED_IDENTITY_CARD_KIND,
  PRODUCT_LINES,
  IdentityCardError,
  validateIdentityCard,
  serializeIdentityCard,
  buildIdentityCardPayload,
  buildIdentityCard,
  validateSignedIdentityCard,
  serializeSignedIdentityCard,
  readIdentityCard,
  verifyIdentityCard,
} = ID;

describe("cli: producer identity card (T-49.1)", function () {
  // A canonical, valid set of card fields, parameterized by the vendor address. claims/nonClaims are
  // non-empty (the load-bearing honest boundary); publishedAt is a canonical ISO instant.
  function cardParams(vendorAddress) {
    return {
      vendorAddress,
      productLine: "evidence",
      claims: [
        "We seal directories into tamper-evident verifyhash evidence packets.",
        "We sign each packet with the key that controls this vendorAddress.",
      ],
      nonClaims: [
        "We do NOT prove any specific packet's contents are true.",
        "We do NOT provide a trusted timestamp or a legal opinion.",
      ],
      publishedAt: "2026-06-26T00:00:00.000Z",
    };
  }

  // Build a SIGNED card with an EPHEMERAL, THROWAWAY in-process key (NEVER persisted, NEVER funded). By
  // default the card asserts the SAME address the signer controls (the honest case).
  async function signedCard(overrides = {}, wallet) {
    const w = wallet || Wallet.createRandom();
    expect(w.privateKey).to.match(/^0x[0-9a-fA-F]{64}$/); // an in-memory key — never a real-funds key
    const params = { ...cardParams(w.address), ...overrides };
    const container = await buildIdentityCard(params, w);
    return { wallet: w, container, params };
  }

  // Surgically re-embed TAMPERED canonical card bytes into a signed container WITHOUT re-signing — the
  // original signature is kept, so recovery over the new bytes diverges from the claimed/vendor address.
  // The tampered card must itself be STRUCTURALLY VALID (the wrap-don't-edit invariant re-validates the
  // embedded payload + requires it byte-equal serializeIdentityCard(embedded)), so the container survives
  // validateSignedIdentityCard and the divergence surfaces as a clean REJECTED verdict (not a hard error).
  function tamperedContainer(container, mutate) {
    const embedded = JSON.parse(container.attestation);
    mutate(embedded); // change a card field in place
    const tamperedBytes = serializeIdentityCard(embedded); // re-canonicalize -> still wrap-don't-edit-valid
    return { ...container, attestation: tamperedBytes };
  }

  // ---------- round-trip ACCEPT ----------

  it("round-trips: buildIdentityCard -> verifyIdentityCard ACCEPTS with the family verdict shape", async function () {
    const { wallet, container } = await signedCard();
    const lc = wallet.address.toLowerCase();

    // The container is a sound signed identity card (its own kinds).
    expect(container.kind).to.equal(SIGNED_IDENTITY_CARD_KIND);
    const embedded = JSON.parse(container.attestation);
    expect(embedded.kind).to.equal(IDENTITY_CARD_KIND);
    expect(embedded.note).to.equal(IDENTITY_CARD_TRUST_NOTE);
    expect(embedded.vendorAddress).to.equal(lc);

    const r = verifyIdentityCard({ container });
    expect(r.verdict).to.equal("ACCEPTED");
    expect(r.accepted).to.equal(true);
    expect(r.recoveredSigner).to.equal(lc);
    expect(r.claimedSigner).to.equal(lc);
    expect(r.vendorAddress).to.equal(lc);
    expect(r.scheme).to.equal("eip191-personal-sign");
    // FAMILY verdict shape + the identity-specific check.
    expect(r.checks.signatureMatchesSigner).to.equal(true);
    expect(r.checks.vendorAddressMatchesSigner).to.equal(true);
    expect(r.checks.signerMatchesExpected).to.equal(null); // not requested
    expect(r.expectedSigner).to.equal(null);
    expect(r.failedChecks).to.deep.equal([]);
  });

  it("round-trips with a CHECKSUMMED vendorAddress input (normalized to lowercase, still ACCEPTS)", async function () {
    const w = Wallet.createRandom();
    const params = { ...cardParams(getAddress(w.address)) }; // EIP-55 checksummed input
    const container = await buildIdentityCard(params, w);
    const r = verifyIdentityCard({ container });
    expect(r.verdict).to.equal("ACCEPTED");
    expect(r.vendorAddress).to.equal(w.address.toLowerCase());
  });

  it("serializeSignedIdentityCard / readIdentityCard round-trip byte-for-byte", async function () {
    const { container } = await signedCard();
    const bytes = serializeSignedIdentityCard(container);
    const reread = readIdentityCard(bytes);
    expect(serializeSignedIdentityCard(reread)).to.equal(bytes);
    expect(verifyIdentityCard({ container: reread }).verdict).to.equal("ACCEPTED");
  });

  // ---------- TAMPER each embedded field -> REJECT naming the failing check ----------

  it("TAMPER claims[] (keep the signature) -> REJECTED on signatureMatchesSigner; NEVER a false ACCEPT", async function () {
    const { container } = await signedCard();
    const tampered = tamperedContainer(container, (c) => {
      c.claims = c.claims.slice();
      c.claims[0] = c.claims[0] + " (silently expanded)";
    });
    const r = verifyIdentityCard({ container: tampered });
    expect(r.verdict).to.equal("REJECTED");
    expect(r.accepted).to.equal(false);
    expect(r.checks.signatureMatchesSigner).to.equal(false);
    expect(r.failedChecks).to.include("signatureMatchesSigner");
  });

  it("TAMPER nonClaims[] (keep the signature) -> REJECTED on signatureMatchesSigner; NEVER a false ACCEPT", async function () {
    const { container } = await signedCard();
    const tampered = tamperedContainer(container, (c) => {
      // Drop the honest "no legal opinion" boundary — exactly the kind of edit verify must catch.
      c.nonClaims = [c.nonClaims[0]];
    });
    const r = verifyIdentityCard({ container: tampered });
    expect(r.verdict).to.equal("REJECTED");
    expect(r.checks.signatureMatchesSigner).to.equal(false);
    expect(r.failedChecks).to.include("signatureMatchesSigner");
  });

  it("TAMPER vendorAddress (keep the signature) -> REJECTED naming BOTH the signature + vendorAddress checks", async function () {
    const { container } = await signedCard();
    const imposter = Wallet.createRandom(); // TEST-ONLY key
    const tampered = tamperedContainer(container, (c) => {
      c.vendorAddress = imposter.address.toLowerCase(); // claim a DIFFERENT address
    });
    const r = verifyIdentityCard({ container: tampered });
    expect(r.verdict).to.equal("REJECTED");
    // The bytes changed, so the original signature no longer recovers to the claimed signer...
    expect(r.checks.signatureMatchesSigner).to.equal(false);
    // ...and the recovered signer is NOT the (now-imposter) vendorAddress either.
    expect(r.checks.vendorAddressMatchesSigner).to.equal(false);
    expect(r.failedChecks).to.include("signatureMatchesSigner");
    expect(r.failedChecks).to.include("vendorAddressMatchesSigner");
    expect(r.vendorAddress).to.equal(imposter.address.toLowerCase());
  });

  it("TAMPER productLine (keep the signature) -> REJECTED on signatureMatchesSigner; NEVER a false ACCEPT", async function () {
    const { container } = await signedCard();
    const tampered = tamperedContainer(container, (c) => {
      c.productLine = "dataledger"; // a DIFFERENT in-set line — still must reject (bytes changed)
    });
    const r = verifyIdentityCard({ container: tampered });
    expect(r.verdict).to.equal("REJECTED");
    expect(r.checks.signatureMatchesSigner).to.equal(false);
    expect(r.failedChecks).to.include("signatureMatchesSigner");
  });

  // ---------- vendorAddress != the recovering signer ----------

  it("a card whose vendorAddress != the recovering signer is REJECTED at verify (vendorAddressMatchesSigner false)", async function () {
    // Build an HONEST card for `claimant` (vendorAddress == claimant), then surgically swap ONLY the
    // embedded vendorAddress to `other` while keeping claimant's signature. The signature still recovers to
    // claimant... but the card now CLAIMS to be `other` -> the vendorAddress check fails.
    const claimant = Wallet.createRandom(); // TEST-ONLY key
    const other = Wallet.createRandom(); // TEST-ONLY key
    const { container } = await signedCard({}, claimant);

    // Hand-craft a container that claims `other` as vendorAddress but is signed by claimant. Because we keep
    // claimant's signature over the ORIGINAL bytes, we must re-embed the ORIGINAL bytes' signature against the
    // CHANGED bytes — which makes signatureMatchesSigner false too; both identity guards fire.
    const tampered = tamperedContainer(container, (c) => {
      c.vendorAddress = other.address.toLowerCase();
    });
    const r = verifyIdentityCard({ container: tampered });
    expect(r.verdict).to.equal("REJECTED");
    expect(r.checks.vendorAddressMatchesSigner).to.equal(false);
    expect(r.recoveredSigner).to.not.equal(other.address.toLowerCase());
  });

  it("buildIdentityCard REFUSES to mint a card for an address the signing key does not control", async function () {
    const signer = Wallet.createRandom(); // controls signer.address
    const otherAddress = Wallet.createRandom().address; // a DIFFERENT address the signer does NOT control
    let threw = null;
    try {
      await buildIdentityCard({ ...cardParams(otherAddress) }, signer);
    } catch (e) {
      threw = e;
    }
    expect(threw).to.be.instanceOf(IdentityCardError);
    expect(threw.message).to.contain("does not control");
    expect(threw.message).to.contain("vendorAddress");
  });

  // ---------- --signer pin to the WRONG address ----------

  it("--signer pinned to the WRONG address -> REJECTED (signature genuine; only the pin fails)", async function () {
    const { wallet, container } = await signedCard();
    const other = Wallet.createRandom(); // TEST-ONLY key

    // Right signer (checksummed input is normalized) -> ACCEPTED + pin PASS.
    const ok = verifyIdentityCard({ container, expectedSigner: getAddress(wallet.address) });
    expect(ok.verdict).to.equal("ACCEPTED");
    expect(ok.checks.signerMatchesExpected).to.equal(true);
    expect(ok.expectedSigner).to.equal(wallet.address.toLowerCase());

    // WRONG signer -> REJECTED, naming ONLY the failed pin (the signature itself is still genuine and the
    // vendorAddress still matches the recovered signer).
    const bad = verifyIdentityCard({ container, expectedSigner: other.address });
    expect(bad.verdict).to.equal("REJECTED");
    expect(bad.checks.signerMatchesExpected).to.equal(false);
    expect(bad.checks.signatureMatchesSigner).to.equal(true);
    expect(bad.checks.vendorAddressMatchesSigner).to.equal(true);
    expect(bad.failedChecks).to.deep.equal(["signerMatchesExpected"]);
  });

  // ---------- HARD validation errors (closed field / closed productLine / empty lists / missing) ----------

  it("an UNKNOWN/extraneous field HARD-errors (closed field set)", function () {
    const w = Wallet.createRandom();
    const payload = buildIdentityCardPayload(cardParams(w.address));
    const bad = { ...payload, surprise: "smuggled" };
    expect(() => validateIdentityCard(bad)).to.throw(IdentityCardError, /unknown field/);
  });

  it("a MISSING required field HARD-errors", function () {
    const w = Wallet.createRandom();
    const base = cardParams(w.address);
    // Missing publishedAt.
    const { publishedAt, ...noDate } = base;
    expect(() => buildIdentityCardPayload(noDate)).to.throw(IdentityCardError, /publishedAt/);
    // Missing vendorAddress.
    const { vendorAddress, ...noVendor } = base;
    expect(() => buildIdentityCardPayload(noVendor)).to.throw(IdentityCardError, /vendorAddress/);
  });

  it("an OUT-OF-SET productLine HARD-errors (closed productLine set)", function () {
    const w = Wallet.createRandom();
    const bad = { ...cardParams(w.address), productLine: "not-a-real-line" };
    expect(() => buildIdentityCardPayload(bad)).to.throw(IdentityCardError, /productLine/);
    // Every documented line is accepted.
    for (const line of PRODUCT_LINES) {
      const ok = buildIdentityCardPayload({ ...cardParams(w.address), productLine: line });
      expect(ok.productLine).to.equal(line);
    }
  });

  it("EMPTY claims HARD-errors; EMPTY nonClaims HARD-errors; a non-string/duplicate entry HARD-errors", function () {
    const w = Wallet.createRandom();
    expect(() => buildIdentityCardPayload({ ...cardParams(w.address), claims: [] })).to.throw(
      IdentityCardError,
      /claims must be a non-empty array/
    );
    expect(() => buildIdentityCardPayload({ ...cardParams(w.address), nonClaims: [] })).to.throw(
      IdentityCardError,
      /nonClaims must be a non-empty array/
    );
    expect(() => buildIdentityCardPayload({ ...cardParams(w.address), claims: ["ok", ""] })).to.throw(
      IdentityCardError,
      /claims entry must be a non-empty string/
    );
    expect(() => buildIdentityCardPayload({ ...cardParams(w.address), claims: ["dup", "dup"] })).to.throw(
      IdentityCardError,
      /duplicate/
    );
    expect(() => buildIdentityCardPayload({ ...cardParams(w.address), nonClaims: [42] })).to.throw(
      IdentityCardError,
      /nonClaims entry must be a non-empty string/
    );
  });

  it("a non-canonical publishedAt (date-only / rolled-over) HARD-errors", function () {
    const w = Wallet.createRandom();
    expect(() => buildIdentityCardPayload({ ...cardParams(w.address), publishedAt: "2026-06-26" })).to.throw(
      IdentityCardError,
      /publishedAt/
    );
    // Feb-29 in a non-leap year rolls over -> rejected by the canonical round-trip.
    expect(() =>
      buildIdentityCardPayload({ ...cardParams(w.address), publishedAt: "2026-02-29T00:00:00.000Z" })
    ).to.throw(IdentityCardError, /publishedAt/);
  });

  it("validateSignedIdentityCard REJECTS a wrong-kind container (HARD error before any verdict)", async function () {
    const { container } = await signedCard();
    const wrong = { ...container, kind: "vh.evidence-seal-signed" };
    expect(() => validateSignedIdentityCard(wrong)).to.throw();
    // verifyIdentityCard also HARD-errors on a structurally invalid container (never a silent verdict).
    expect(() => verifyIdentityCard({ container: wrong })).to.throw();
  });

  // ---------- PURITY: no filesystem side effects ----------

  it("is PURE: build + verify write NOTHING to cwd", async function () {
    const before = fs.readdirSync(process.cwd()).sort();
    const { container } = await signedCard();
    verifyIdentityCard({ container });
    verifyIdentityCard({ container, expectedSigner: container.signature.signer });
    const after = fs.readdirSync(process.cwd()).sort();
    expect(after).to.deep.equal(before);
  });
});

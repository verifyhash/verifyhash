"use strict";

// TrustLedger — license.js tests (T-29.1).
//
// PURE / OFFLINE — no live node, no filesystem, no key persistence. Every signing key is an EPHEMERAL,
// in-process `Wallet.createRandom()` (TEST-ONLY, NEVER a real key / real funds), exactly like the seal
// tests. Proves the license core:
//   * round-trip mint -> verify with the matching vendor address is `valid` and carries the right
//     entitlements;
//   * a license signed by a DIFFERENT key is `wrong_issuer`;
//   * a tampered embedded payload byte flips the verdict to `bad_signature`;
//   * an expiresAt in the PAST is `expired`; an issuedAt in the FUTURE is `not_yet_valid`;
//   * an unknown entitlement / bad date / missing field / expiresAt<=issuedAt is rejected AT BUILD,
//     and a hand-corrupted container is rejected AT VERIFY (`malformed`);
//   * hasEntitlement is false for ANY non-valid verdict, and only true for a present flag on a valid
//     verdict;
//   * the license reuses the EXISTING cli/core/attestation.js envelope (recoverSigner /
//     verifySignedAttestation round-trip) — proving REUSE, not a re-implementation.

const { expect } = require("chai");
const { Wallet, getAddress } = require("ethers");

const license = require("../trustledger/license");
const coreAttestation = require("../cli/core/attestation");

const {
  LICENSE_KIND,
  LICENSE_SCHEMA_VERSION,
  LICENSE_TRUST_NOTE,
  ENTITLEMENTS,
  ENTITLEMENT_FLAGS,
  LicenseError,
  validateLicense,
  serializeLicense,
  buildLicensePayload,
  buildLicense,
  validateSignedLicense,
  serializeSignedLicense,
  readLicense,
  verifyLicense,
  hasEntitlement,
} = license;

// A representative, valid license field set. Returns a FRESH object each call so a mutation in one test
// never leaks into another.
function sampleParams(overrides) {
  return Object.assign(
    {
      licenseId: "LIC-2026-0001",
      customer: "Acme Realty LLC",
      plan: "pro-annual",
      entitlements: ["seal", "multi_state_policy"],
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2027-01-01T00:00:00.000Z",
    },
    overrides || {}
  );
}

// An instant inside [issuedAt, expiresAt] for the sample license.
const NOW_IN_WINDOW = "2026-06-23T12:00:00.000Z";

describe("trustledger/license — unsigned payload build + strict validation", () => {
  it("buildLicensePayload produces a canonical, sorted-entitlement payload", () => {
    const p = buildLicensePayload(sampleParams());
    expect(p.kind).to.equal(LICENSE_KIND);
    expect(p.schemaVersion).to.equal(LICENSE_SCHEMA_VERSION);
    expect(p.note).to.equal(LICENSE_TRUST_NOTE);
    expect(p.licenseId).to.equal("LIC-2026-0001");
    // Entitlements emitted in the FROZEN table order regardless of caller order.
    expect(p.entitlements).to.deep.equal(["multi_state_policy", "seal"]);
  });

  it("serializeLicense is byte-deterministic and order-independent", () => {
    const a = serializeLicense(buildLicensePayload(sampleParams({ entitlements: ["seal", "multi_state_policy"] })));
    const b = serializeLicense(buildLicensePayload(sampleParams({ entitlements: ["multi_state_policy", "seal"] })));
    expect(a).to.equal(b);
    expect(a.endsWith("\n")).to.equal(true);
  });

  it("ENTITLEMENTS is the single closed table and ENTITLEMENT_FLAGS is its sorted keys", () => {
    expect(ENTITLEMENT_FLAGS).to.deep.equal(Object.keys(ENTITLEMENTS).sort());
    expect(ENTITLEMENT_FLAGS).to.include.members(["seal", "multi_state_policy", "unlimited_reconcile"]);
  });

  it("REJECTS an unknown entitlement at build", () => {
    expect(() => buildLicensePayload(sampleParams({ entitlements: ["seal", "teleportation"] }))).to.throw(
      LicenseError,
      /unknown license entitlement/
    );
  });

  it("REJECTS a duplicate entitlement at build", () => {
    expect(() => buildLicensePayload(sampleParams({ entitlements: ["seal", "seal"] }))).to.throw(
      LicenseError,
      /duplicate entitlement/
    );
  });

  it("REJECTS an empty entitlement list at build", () => {
    expect(() => buildLicensePayload(sampleParams({ entitlements: [] }))).to.throw(LicenseError, /entitlements/);
  });

  it("REJECTS a missing required field at build", () => {
    const p = sampleParams();
    delete p.customer;
    expect(() => buildLicensePayload(p)).to.throw(LicenseError, /customer must be a non-empty string/);
  });

  it("REJECTS a non-ISO date at build", () => {
    expect(() => buildLicensePayload(sampleParams({ issuedAt: "2026-01-01" }))).to.throw(
      LicenseError,
      /issuedAt must be an ISO-8601 UTC instant/
    );
    expect(() => buildLicensePayload(sampleParams({ expiresAt: "2027-01-01T00:00:00+05:00" }))).to.throw(
      LicenseError,
      /expiresAt must be an ISO-8601 UTC instant/
    );
  });

  it("REJECTS a non-canonical (missing-millis) instant — pins the byte-determinism guarantee", () => {
    // "...:00Z" is the SAME logical instant as "...:00.000Z" but a DIFFERENT byte string. If accepted,
    // two logically-identical licenses would serialize/sign differently — the exact property
    // serializeLicense promises is impossible. The regex makes `.mmm` optional, so this is caught ONLY by
    // the toISOString round-trip equality, not the regex.
    expect(() => buildLicensePayload(sampleParams({ issuedAt: "2026-01-01T00:00:00Z" }))).to.throw(
      LicenseError,
      /issuedAt must be a canonical ISO-8601 UTC instant/
    );
    // Proof it is byte-distinct: the canonical millis form serializes, the bare form is rejected.
    const canonical = serializeLicense(buildLicensePayload(sampleParams({ issuedAt: "2026-01-01T00:00:00.000Z" })));
    expect(canonical).to.contain("2026-01-01T00:00:00.000Z");
  });

  it("REJECTS an impossible / rolled-over calendar instant — never silently coerced", () => {
    // 2026 is NOT a leap year, so Feb 29 is impossible. Date.parse would silently ROLL it over to
    // 2026-03-01 (a quiet coercion of a self-asserted date). The round-trip equality rejects it: the
    // bytes a human reads must equal the bytes that are signed.
    expect(() => buildLicensePayload(sampleParams({ issuedAt: "2026-02-29T00:00:00.000Z" }))).to.throw(
      LicenseError,
      /issuedAt must be a canonical ISO-8601 UTC instant/
    );
    // Hour 24 is also rolled over by Date.parse (-> next day); rejected here.
    expect(() => buildLicensePayload(sampleParams({ expiresAt: "2027-01-01T24:00:00.000Z" }))).to.throw(
      LicenseError,
      /expiresAt must be a canonical ISO-8601 UTC instant/
    );
    // Day 31 of a 30-day month rolls over too; rejected.
    expect(() => buildLicensePayload(sampleParams({ expiresAt: "2027-04-31T00:00:00.000Z" }))).to.throw(
      LicenseError,
      /expiresAt must be a canonical ISO-8601 UTC instant/
    );
    // A real leap-year Feb 29 (2028 IS a leap year) is ACCEPTED — the guard rejects only impossible ones.
    expect(() =>
      buildLicensePayload(sampleParams({ issuedAt: "2028-02-29T00:00:00.000Z", expiresAt: "2029-01-01T00:00:00.000Z" }))
    ).to.not.throw();
  });

  it("a hand-corrupted container carrying a non-canonical date is rejected at verify (malformed)", async () => {
    const vendor = Wallet.createRandom();
    const container = await buildLicense(sampleParams(), vendor);
    // Hand-edit the embedded payload to a missing-millis (non-canonical) issuedAt and re-stringify.
    const broken = JSON.parse(serializeSignedLicense(container));
    const badPayload = JSON.parse(broken.attestation);
    badPayload.issuedAt = "2026-01-01T00:00:00Z"; // non-canonical millis form
    broken.attestation = JSON.stringify(badPayload);
    const v = verifyLicense(broken, { now: NOW_IN_WINDOW, vendorAddress: vendor.address });
    expect(v.valid).to.equal(false);
    expect(v.reason).to.equal("malformed");
  });

  it("REJECTS expiresAt <= issuedAt at build", () => {
    expect(() =>
      buildLicensePayload(sampleParams({ issuedAt: "2027-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:00:00.000Z" }))
    ).to.throw(LicenseError, /expiresAt .* must be strictly AFTER issuedAt/);
    // Equal is also rejected.
    expect(() =>
      buildLicensePayload(sampleParams({ issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:00:00.000Z" }))
    ).to.throw(LicenseError, /strictly AFTER/);
  });

  it("validateLicense REJECTS a drifted note", () => {
    const p = buildLicensePayload(sampleParams());
    p.note = "trust me";
    expect(() => validateLicense(p)).to.throw(LicenseError, /note/);
  });
});

describe("trustledger/license — mint + OFFLINE verify (ephemeral keys only)", () => {
  it("round-trips mint -> verify VALID with the matching vendor address and carries the right entitlements", async () => {
    const vendor = Wallet.createRandom();
    const container = await buildLicense(sampleParams(), vendor);

    // Container is a sound signed envelope reusing the shared core.
    validateSignedLicense(container);
    expect(container.kind).to.equal("trustledger-license-signed");

    const v = verifyLicense(container, { now: NOW_IN_WINDOW, vendorAddress: vendor.address });
    expect(v.valid).to.equal(true);
    expect(v.reason).to.equal(null);
    expect(v.recoveredSigner).to.equal(vendor.address.toLowerCase());
    expect(v.entitlements).to.deep.equal(["multi_state_policy", "seal"]);

    // hasEntitlement gate.
    expect(hasEntitlement(v, "seal")).to.equal(true);
    expect(hasEntitlement(v, "multi_state_policy")).to.equal(true);
    expect(hasEntitlement(v, "unlimited_reconcile")).to.equal(false); // not granted
    expect(hasEntitlement(v, "teleportation")).to.equal(false); // unknown flag
  });

  it("REUSE PROOF: the signed license recovers its signer via the EXISTING attestation core", async () => {
    const vendor = Wallet.createRandom();
    const container = await buildLicense(sampleParams(), vendor);
    // recover via the shared core directly (not via license.js) — proves the envelope is reused verbatim.
    const recovered = coreAttestation.recoverSigner(container);
    expect(recovered).to.equal(vendor.address.toLowerCase());
    const att = coreAttestation.verifySignedAttestation({
      container,
      expectedSigner: vendor.address,
    });
    expect(att.accepted).to.equal(true);
    // round-trips through serialize/read.
    const bytes = serializeSignedLicense(container);
    const back = readLicense(bytes);
    expect(back).to.deep.equal(container);
  });

  it("a license signed by a DIFFERENT key is wrong_issuer (not trusted)", async () => {
    const vendor = Wallet.createRandom();
    const imposter = Wallet.createRandom();
    // Imposter signs a perfectly well-formed license, but it is NOT the vendor key.
    const container = await buildLicense(sampleParams(), imposter);

    const v = verifyLicense(container, { now: NOW_IN_WINDOW, vendorAddress: vendor.address });
    expect(v.valid).to.equal(false);
    expect(v.reason).to.equal("wrong_issuer");
    expect(v.recoveredSigner).to.equal(imposter.address.toLowerCase());
    expect(hasEntitlement(v, "seal")).to.equal(false); // entitles NOTHING
  });

  it("a tampered embedded payload byte flips the verdict to bad_signature", async () => {
    const vendor = Wallet.createRandom();
    const container = await buildLicense(sampleParams(), vendor);

    // Swap in the canonical bytes of a DIFFERENT (still valid) license while keeping the original
    // signature. The container stays structurally sound (the embedded payload is a canonical valid
    // license), but the signature was made over the ORIGINAL bytes -> recovers to a different address ->
    // signatureMatchesSigner is false -> bad_signature.
    const otherPayload = buildLicensePayload(sampleParams({ licenseId: "LIC-2026-9999" }));
    const tampered = JSON.parse(serializeSignedLicense(container));
    tampered.attestation = serializeLicense(otherPayload);

    // Still a structurally valid signed-license container (passes validateSignedLicense)...
    expect(() => validateSignedLicense(tampered)).to.not.throw();
    // ...but verify localizes it as bad_signature, never valid.
    const v = verifyLicense(tampered, { now: NOW_IN_WINDOW, vendorAddress: vendor.address });
    expect(v.valid).to.equal(false);
    expect(v.reason).to.equal("bad_signature");
    expect(hasEntitlement(v, "seal")).to.equal(false);
  });

  it("an expiresAt in the past is expired", async () => {
    const vendor = Wallet.createRandom();
    const container = await buildLicense(
      sampleParams({ issuedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2021-01-01T00:00:00.000Z" }),
      vendor
    );
    const v = verifyLicense(container, { now: NOW_IN_WINDOW, vendorAddress: vendor.address });
    expect(v.valid).to.equal(false);
    expect(v.reason).to.equal("expired");
    expect(hasEntitlement(v, "seal")).to.equal(false);
  });

  it("an issuedAt in the future is not_yet_valid", async () => {
    const vendor = Wallet.createRandom();
    const container = await buildLicense(
      sampleParams({ issuedAt: "2030-01-01T00:00:00.000Z", expiresAt: "2031-01-01T00:00:00.000Z" }),
      vendor
    );
    const v = verifyLicense(container, { now: NOW_IN_WINDOW, vendorAddress: vendor.address });
    expect(v.valid).to.equal(false);
    expect(v.reason).to.equal("not_yet_valid");
    expect(hasEntitlement(v, "seal")).to.equal(false);
  });

  it("the window is inclusive at both ends", async () => {
    const vendor = Wallet.createRandom();
    const issuedAt = "2026-01-01T00:00:00.000Z";
    const expiresAt = "2027-01-01T00:00:00.000Z";
    const container = await buildLicense(sampleParams({ issuedAt, expiresAt }), vendor);
    expect(verifyLicense(container, { now: issuedAt, vendorAddress: vendor.address }).valid).to.equal(true);
    expect(verifyLicense(container, { now: expiresAt, vendorAddress: vendor.address }).valid).to.equal(true);
    // one ms outside each bound is rejected.
    expect(
      verifyLicense(container, { now: Date.parse(issuedAt) - 1, vendorAddress: vendor.address }).reason
    ).to.equal("not_yet_valid");
    expect(
      verifyLicense(container, { now: Date.parse(expiresAt) + 1, vendorAddress: vendor.address }).reason
    ).to.equal("expired");
  });

  it("a hand-corrupted container is rejected at verify as malformed", async () => {
    const vendor = Wallet.createRandom();
    const container = await buildLicense(sampleParams(), vendor);

    // Corrupt the embedded payload into NON-canonical / invalid form: an unknown entitlement smuggled in.
    const broken = JSON.parse(serializeSignedLicense(container));
    const badPayload = JSON.parse(broken.attestation);
    badPayload.entitlements = ["seal", "teleportation"]; // unknown flag
    broken.attestation = JSON.stringify(badPayload); // not even canonical, and invalid

    const v = verifyLicense(broken, { now: NOW_IN_WINDOW, vendorAddress: vendor.address });
    expect(v.valid).to.equal(false);
    expect(v.reason).to.equal("malformed");

    // A totally garbage container (wrong kind) is also malformed, never valid.
    const v2 = verifyLicense({ kind: "nope" }, { now: NOW_IN_WINDOW, vendorAddress: vendor.address });
    expect(v2.reason).to.equal("malformed");
  });

  it("verifyLicense requires a valid vendorAddress and now (caller errors are thrown)", async () => {
    const vendor = Wallet.createRandom();
    const container = await buildLicense(sampleParams(), vendor);
    expect(() => verifyLicense(container, { now: NOW_IN_WINDOW, vendorAddress: "not-an-address" })).to.throw(
      LicenseError,
      /valid vendorAddress/
    );
    expect(() => verifyLicense(container, { now: "not-a-date", vendorAddress: vendor.address })).to.throw(
      LicenseError,
      /valid `now`/
    );
    // A checksummed vendor address is accepted (normalized).
    const v = verifyLicense(container, { now: NOW_IN_WINDOW, vendorAddress: getAddress(vendor.address) });
    expect(v.valid).to.equal(true);
  });

  it("hasEntitlement is false for ANY non-valid verdict shape", () => {
    expect(hasEntitlement(null, "seal")).to.equal(false);
    expect(hasEntitlement({}, "seal")).to.equal(false);
    expect(hasEntitlement({ valid: false, entitlements: ["seal"] }, "seal")).to.equal(false);
    expect(hasEntitlement({ valid: true, entitlements: ["seal"] }, "seal")).to.equal(true);
    expect(hasEntitlement({ valid: true, entitlements: ["seal"] }, 123)).to.equal(false);
  });
});

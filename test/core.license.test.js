"use strict";

// cli/core/license.js tests (T-30.1) — the PRODUCT-AGNOSTIC signed-entitlement core.
//
// These tests exercise the generic core with a SYNTHETIC product cfg (a DIFFERENT `kind` + a DIFFERENT
// CLOSED entitlement table than TrustLedger's), proving the core is genuinely product-parameterized — not
// secretly hard-wired to TrustLedger. The companion test/trustledger.license.test.js (UNCHANGED) proves
// the TrustLedger adapter preserves behaviour byte-for-byte.
//
// PURE / OFFLINE — no live node, no filesystem, no key persistence. Every signing key is an EPHEMERAL,
// in-process `Wallet.createRandom()` (TEST-ONLY, NEVER a real key / real funds). Proves the core:
//   * round-trips mint -> verify VALID with the matching vendor address, carrying the right entitlements;
//   * pins the vendor — a DIFFERENT signer is wrong_issuer (entitles nothing);
//   * rejects expired / not_yet_valid / malformed / unknown-entitlement / tampered (bad_signature);
//   * is byte-deterministic for a fixed `now` (same container + now + vendor + cfg => identical verdict);
//   * reuses the EXISTING cli/core/attestation.js envelope (recoverSigner / verifySignedAttestation).

const { expect } = require("chai");
const { Wallet, getAddress } = require("ethers");

const coreLicense = require("../cli/core/license");
const coreAttestation = require("../cli/core/attestation");

const {
  LicenseError,
  entitlementFlags,
  validateLicense,
  serializeLicense,
  buildLicensePayload,
  buildLicense,
  validateSignedLicense,
  serializeSignedLicense,
  readLicense,
  verifyLicense,
  hasEntitlement,
} = coreLicense;

// ---------------------------------------------------------------------------
// A SYNTHETIC product cfg — deliberately DIFFERENT from TrustLedger's: a different unsigned `kind`, a
// different signed `kind`, a different note, and a DIFFERENT closed entitlement table. If the core were
// secretly hard-wired to TrustLedger's table/kind, these tests would fail.
// ---------------------------------------------------------------------------

const SYN_NOTE =
  "SYNTHETIC product license note — used only by the core test to prove the engine is product-parameterized.";
const SYN_SIGNED_NOTE = "SYNTHETIC signed-license container note. " + SYN_NOTE;

const SYN_CFG = Object.freeze({
  kind: "syntheticco-license",
  schemaVersion: 1,
  supportedSchemaVersions: Object.freeze([1]),
  note: SYN_NOTE,
  entitlements: Object.freeze({
    widgets_pro: "Unlimited widgets.",
    export_csv: "CSV export.",
    api_access: "Programmatic API access.",
  }),
  signedKind: "syntheticco-license-signed",
  signedSchemaVersion: 1,
  supportedSignedSchemaVersions: Object.freeze([1]),
  signedNote: SYN_SIGNED_NOTE,
  signedLabel: "signed synthetic license",
});

// A representative, valid license field set for the synthetic product. Fresh object each call.
function sampleParams(overrides) {
  return Object.assign(
    {
      licenseId: "SYN-2026-0001",
      customer: "Globex Corporation",
      plan: "enterprise",
      entitlements: ["api_access", "widgets_pro"],
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2027-01-01T00:00:00.000Z",
    },
    overrides || {}
  );
}

const NOW_IN_WINDOW = "2026-06-23T12:00:00.000Z";

describe("cli/core/license — generic unsigned payload build + strict validation (synthetic cfg)", () => {
  it("entitlementFlags is the sorted keys of the cfg table", () => {
    expect(entitlementFlags(SYN_CFG)).to.deep.equal(["api_access", "export_csv", "widgets_pro"]);
  });

  it("buildLicensePayload stamps the cfg kind/schema/note and sorts entitlements by the cfg table", () => {
    const p = buildLicensePayload(sampleParams(), SYN_CFG);
    expect(p.kind).to.equal("syntheticco-license");
    expect(p.schemaVersion).to.equal(1);
    expect(p.note).to.equal(SYN_NOTE);
    expect(p.licenseId).to.equal("SYN-2026-0001");
    // Emitted in the FROZEN cfg-table order regardless of caller order.
    expect(p.entitlements).to.deep.equal(["api_access", "widgets_pro"]);
  });

  it("serializeLicense is byte-deterministic + order-independent + newline-terminated", () => {
    const a = serializeLicense(buildLicensePayload(sampleParams({ entitlements: ["api_access", "widgets_pro"] }), SYN_CFG), SYN_CFG);
    const b = serializeLicense(buildLicensePayload(sampleParams({ entitlements: ["widgets_pro", "api_access"] }), SYN_CFG), SYN_CFG);
    expect(a).to.equal(b);
    expect(a.endsWith("\n")).to.equal(true);
  });

  it("REJECTS an entitlement NOT in the supplied cfg table (a TrustLedger flag is unknown here)", () => {
    // "seal" is a TrustLedger entitlement; it is NOT in SYN_CFG, so it is a hard build REJECT here —
    // proving the table is the cfg's, not a global.
    expect(() => buildLicensePayload(sampleParams({ entitlements: ["seal"] }), SYN_CFG)).to.throw(
      LicenseError,
      /unknown license entitlement/
    );
    expect(() => buildLicensePayload(sampleParams({ entitlements: ["widgets_pro", "teleport"] }), SYN_CFG)).to.throw(
      LicenseError,
      /unknown license entitlement/
    );
  });

  it("REJECTS duplicate / empty entitlements, missing fields, bad + non-canonical dates, expiresAt<=issuedAt", () => {
    expect(() => buildLicensePayload(sampleParams({ entitlements: ["api_access", "api_access"] }), SYN_CFG)).to.throw(
      LicenseError,
      /duplicate entitlement/
    );
    expect(() => buildLicensePayload(sampleParams({ entitlements: [] }), SYN_CFG)).to.throw(LicenseError, /entitlements/);
    const p = sampleParams();
    delete p.customer;
    expect(() => buildLicensePayload(p, SYN_CFG)).to.throw(LicenseError, /customer must be a non-empty string/);
    expect(() => buildLicensePayload(sampleParams({ issuedAt: "2026-01-01" }), SYN_CFG)).to.throw(
      LicenseError,
      /issuedAt must be an ISO-8601 UTC instant/
    );
    // Non-canonical (missing-millis) — caught by the toISOString round-trip, not the regex.
    expect(() => buildLicensePayload(sampleParams({ issuedAt: "2026-01-01T00:00:00Z" }), SYN_CFG)).to.throw(
      LicenseError,
      /issuedAt must be a canonical ISO-8601 UTC instant/
    );
    // Impossible calendar instant (2026 is not a leap year) is rejected, never silently rolled over.
    expect(() => buildLicensePayload(sampleParams({ issuedAt: "2026-02-29T00:00:00.000Z" }), SYN_CFG)).to.throw(
      LicenseError,
      /issuedAt must be a canonical ISO-8601 UTC instant/
    );
    expect(() =>
      buildLicensePayload(sampleParams({ issuedAt: "2027-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:00:00.000Z" }), SYN_CFG)
    ).to.throw(LicenseError, /expiresAt .* must be strictly AFTER issuedAt/);
  });

  it("validateLicense REJECTS a drifted note + a wrong kind", () => {
    const p = buildLicensePayload(sampleParams(), SYN_CFG);
    p.note = "drifted";
    expect(() => validateLicense(p, SYN_CFG)).to.throw(LicenseError, /note/);
    const q = buildLicensePayload(sampleParams(), SYN_CFG);
    q.kind = "trustledger-license";
    expect(() => validateLicense(q, SYN_CFG)).to.throw(LicenseError, /not a trustledger license/);
  });

  it("the core requires a structurally complete cfg", () => {
    expect(() => buildLicensePayload(sampleParams(), null)).to.throw(/license core requires/);
    expect(() => buildLicensePayload(sampleParams(), {})).to.throw(/license core config requires/);
    const noTable = Object.assign({}, SYN_CFG, { entitlements: {} });
    expect(() => buildLicensePayload(sampleParams(), noTable)).to.throw(/non-empty `entitlements` table/);
  });
});

describe("cli/core/license — generic mint + OFFLINE verify (synthetic cfg, ephemeral keys only)", () => {
  it("round-trips mint -> verify VALID with the matching vendor address + carries the right entitlements", async () => {
    const vendor = Wallet.createRandom();
    const container = await buildLicense(sampleParams(), vendor, SYN_CFG);

    validateSignedLicense(container, SYN_CFG);
    expect(container.kind).to.equal("syntheticco-license-signed");

    const v = verifyLicense(container, { now: NOW_IN_WINDOW, vendorAddress: vendor.address, cfg: SYN_CFG });
    expect(v.valid).to.equal(true);
    expect(v.reason).to.equal(null);
    expect(v.recoveredSigner).to.equal(vendor.address.toLowerCase());
    expect(v.entitlements).to.deep.equal(["api_access", "widgets_pro"]);

    expect(hasEntitlement(v, "api_access")).to.equal(true);
    expect(hasEntitlement(v, "widgets_pro")).to.equal(true);
    expect(hasEntitlement(v, "export_csv")).to.equal(false); // not granted
    expect(hasEntitlement(v, "seal")).to.equal(false); // not even in this product
  });

  it("is byte-deterministic: same container + now + vendor + cfg => identical verdict", async () => {
    const vendor = Wallet.createRandom();
    const container = await buildLicense(sampleParams(), vendor, SYN_CFG);
    const v1 = verifyLicense(container, { now: NOW_IN_WINDOW, vendorAddress: vendor.address, cfg: SYN_CFG });
    const v2 = verifyLicense(container, { now: NOW_IN_WINDOW, vendorAddress: vendor.address, cfg: SYN_CFG });
    expect(JSON.stringify(v1)).to.equal(JSON.stringify(v2));
    // The serialized signed container is also byte-stable across two serializations.
    expect(serializeSignedLicense(container, SYN_CFG)).to.equal(serializeSignedLicense(container, SYN_CFG));
  });

  it("REUSE PROOF: the signed license recovers its signer via the EXISTING attestation core", async () => {
    const vendor = Wallet.createRandom();
    const container = await buildLicense(sampleParams(), vendor, SYN_CFG);
    const recovered = coreAttestation.recoverSigner(container);
    expect(recovered).to.equal(vendor.address.toLowerCase());
    const att = coreAttestation.verifySignedAttestation({ container, expectedSigner: vendor.address });
    expect(att.accepted).to.equal(true);
    // round-trips through serialize/read.
    const bytes = serializeSignedLicense(container, SYN_CFG);
    const back = readLicense(bytes, SYN_CFG);
    expect(back).to.deep.equal(container);
  });

  it("pins the vendor: a license signed by a DIFFERENT key is wrong_issuer (entitles nothing)", async () => {
    const vendor = Wallet.createRandom();
    const imposter = Wallet.createRandom();
    const container = await buildLicense(sampleParams(), imposter, SYN_CFG);
    const v = verifyLicense(container, { now: NOW_IN_WINDOW, vendorAddress: vendor.address, cfg: SYN_CFG });
    expect(v.valid).to.equal(false);
    expect(v.reason).to.equal("wrong_issuer");
    expect(v.recoveredSigner).to.equal(imposter.address.toLowerCase());
    expect(hasEntitlement(v, "api_access")).to.equal(false);
  });

  it("a tampered embedded payload byte flips the verdict to bad_signature", async () => {
    const vendor = Wallet.createRandom();
    const container = await buildLicense(sampleParams(), vendor, SYN_CFG);
    const otherPayload = buildLicensePayload(sampleParams({ licenseId: "SYN-2026-9999" }), SYN_CFG);
    const tampered = JSON.parse(serializeSignedLicense(container, SYN_CFG));
    tampered.attestation = serializeLicense(otherPayload, SYN_CFG);
    // Still structurally a valid signed container...
    expect(() => validateSignedLicense(tampered, SYN_CFG)).to.not.throw();
    // ...but verify localizes it as bad_signature, never valid.
    const v = verifyLicense(tampered, { now: NOW_IN_WINDOW, vendorAddress: vendor.address, cfg: SYN_CFG });
    expect(v.valid).to.equal(false);
    expect(v.reason).to.equal("bad_signature");
    expect(hasEntitlement(v, "api_access")).to.equal(false);
  });

  it("an expiresAt in the past is expired; an issuedAt in the future is not_yet_valid", async () => {
    const vendor = Wallet.createRandom();
    const past = await buildLicense(
      sampleParams({ issuedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2021-01-01T00:00:00.000Z" }),
      vendor,
      SYN_CFG
    );
    expect(verifyLicense(past, { now: NOW_IN_WINDOW, vendorAddress: vendor.address, cfg: SYN_CFG }).reason).to.equal(
      "expired"
    );
    const future = await buildLicense(
      sampleParams({ issuedAt: "2030-01-01T00:00:00.000Z", expiresAt: "2031-01-01T00:00:00.000Z" }),
      vendor,
      SYN_CFG
    );
    expect(verifyLicense(future, { now: NOW_IN_WINDOW, vendorAddress: vendor.address, cfg: SYN_CFG }).reason).to.equal(
      "not_yet_valid"
    );
  });

  it("the window is inclusive at both ends, exclusive one ms outside", async () => {
    const vendor = Wallet.createRandom();
    const issuedAt = "2026-01-01T00:00:00.000Z";
    const expiresAt = "2027-01-01T00:00:00.000Z";
    const container = await buildLicense(sampleParams({ issuedAt, expiresAt }), vendor, SYN_CFG);
    expect(verifyLicense(container, { now: issuedAt, vendorAddress: vendor.address, cfg: SYN_CFG }).valid).to.equal(true);
    expect(verifyLicense(container, { now: expiresAt, vendorAddress: vendor.address, cfg: SYN_CFG }).valid).to.equal(true);
    expect(
      verifyLicense(container, { now: Date.parse(issuedAt) - 1, vendorAddress: vendor.address, cfg: SYN_CFG }).reason
    ).to.equal("not_yet_valid");
    expect(
      verifyLicense(container, { now: Date.parse(expiresAt) + 1, vendorAddress: vendor.address, cfg: SYN_CFG }).reason
    ).to.equal("expired");
  });

  it("a hand-corrupted container (unknown entitlement smuggled in / wrong kind) is malformed at verify", async () => {
    const vendor = Wallet.createRandom();
    const container = await buildLicense(sampleParams(), vendor, SYN_CFG);
    const broken = JSON.parse(serializeSignedLicense(container, SYN_CFG));
    const badPayload = JSON.parse(broken.attestation);
    badPayload.entitlements = ["widgets_pro", "seal"]; // "seal" is unknown to this product
    broken.attestation = JSON.stringify(badPayload);
    const v = verifyLicense(broken, { now: NOW_IN_WINDOW, vendorAddress: vendor.address, cfg: SYN_CFG });
    expect(v.valid).to.equal(false);
    expect(v.reason).to.equal("malformed");

    const v2 = verifyLicense({ kind: "nope" }, { now: NOW_IN_WINDOW, vendorAddress: vendor.address, cfg: SYN_CFG });
    expect(v2.reason).to.equal("malformed");
  });

  it("verifyLicense requires a cfg, a valid vendorAddress, and a valid now (caller errors thrown)", async () => {
    const vendor = Wallet.createRandom();
    const container = await buildLicense(sampleParams(), vendor, SYN_CFG);
    expect(() => verifyLicense(container, { now: NOW_IN_WINDOW, vendorAddress: vendor.address })).to.throw(
      /license core requires/
    );
    expect(() =>
      verifyLicense(container, { now: NOW_IN_WINDOW, vendorAddress: "not-an-address", cfg: SYN_CFG })
    ).to.throw(LicenseError, /valid vendorAddress/);
    expect(() => verifyLicense(container, { now: "not-a-date", vendorAddress: vendor.address, cfg: SYN_CFG })).to.throw(
      LicenseError,
      /valid `now`/
    );
    // A checksummed vendor address is accepted (normalized).
    const v = verifyLicense(container, { now: NOW_IN_WINDOW, vendorAddress: getAddress(vendor.address), cfg: SYN_CFG });
    expect(v.valid).to.equal(true);
  });

  it("hasEntitlement is false for ANY non-valid verdict shape (product-agnostic)", () => {
    expect(hasEntitlement(null, "widgets_pro")).to.equal(false);
    expect(hasEntitlement({}, "widgets_pro")).to.equal(false);
    expect(hasEntitlement({ valid: false, entitlements: ["widgets_pro"] }, "widgets_pro")).to.equal(false);
    expect(hasEntitlement({ valid: true, entitlements: ["widgets_pro"] }, "widgets_pro")).to.equal(true);
    expect(hasEntitlement({ valid: true, entitlements: ["widgets_pro"] }, 123)).to.equal(false);
  });
});

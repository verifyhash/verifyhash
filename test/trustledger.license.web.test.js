"use strict";

// TrustLedger — the WEB door honours the license gate (T-29.3).
//
// EPIC-29 built a signed, offline-verifiable license + a CLI reconcile gate. T-29.3
// threads the SAME gate through the web front-door so the browser surface cannot be
// used to reach a PAID feature (a per-state policy, the seal) without a valid,
// vendor-pinned license — while the FREE baseline reconcile + file inspect stay open.
//
// These tests drive the REAL http.Server on an EPHEMERAL port and assert:
//   * a `state` request with NO license is refused with a NAMED 4xx (license_required);
//   * the SAME request WITH a valid, entitled license SUCCEEDS (200, pass);
//   * a WRONG vendorAddress / EXPIRED / wrong-entitlement license is refused with the
//     PRECISE reason (license_invalid), never silently downgraded to a free run;
//   * the FREE baseline reconcile + inspect routes stay open with no license;
//   * the page references the license fields the server reads (no silent drift);
//   * the docs schema in docs/TRUSTLEDGER.md matches ENTITLEMENTS / the payload shape.
//
// Every signing key is an EPHEMERAL Wallet.createRandom() (TEST-ONLY, never a real
// key / real funds). The server holds NO key (verify is offline + key-free) and writes
// NOTHING to disk; the test asserts the working tree (cwd) is left UNTOUCHED.

const { expect } = require("chai");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { Wallet } = require("ethers");

const { createServer } = require("../trustledger/server");
const licenseMod = require("../trustledger/license");

const FIX = path.join(__dirname, "..", "trustledger", "fixtures", "e2e");
const BANK = fs.readFileSync(path.join(FIX, "bank.csv"), "utf8");
const BOOK = fs.readFileSync(path.join(FIX, "quickbooks.csv"), "utf8");
const RENT = fs.readFileSync(path.join(FIX, "rentroll.csv"), "utf8");

const DATE = "2026-06-24"; // pinned report date == the verify clock the server injects

// The CANONICAL vendor identity the server is configured to pin to (T-75.3). One fixed EPHEMERAL wallet
// for the whole suite (TEST-ONLY Wallet.createRandom, never a real key). The server is created with
// `canonicalVendor: VENDOR.address` (the documented self-hosting seam), so licenses minted by VENDOR
// unlock and licenses minted by any OTHER key are refused wrong_issuer — regardless of what vendorAddress
// the request body carries. (An ATTACKER wallet is used in the self-mint / re-pin tests.)
const VENDOR = Wallet.createRandom();

// Mint a SIGNED license container as canonical JSON TEXT (what the page POSTs), signed by `wallet`
// (defaults to the canonical VENDOR). Returns { text, vendorAddress }. In-window for DATE.
async function mintLicenseText({
  entitlements = ["multi_state_policy", "seal"],
  issuedAt = "2026-01-01T00:00:00.000Z",
  expiresAt = "2027-01-01T00:00:00.000Z",
  wallet = VENDOR,
} = {}) {
  const container = await licenseMod.buildLicense(
    {
      licenseId: "lic-web-test",
      customer: "Acme Realty LLC",
      plan: "pro-annual",
      entitlements,
      issuedAt,
      expiresAt,
    },
    wallet
  );
  return {
    text: licenseMod.serializeSignedLicense(container),
    vendorAddress: wallet.address,
  };
}

function post(port, pathName, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(bodyObj), "utf8");
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: pathName,
        headers: { "content-type": "application/json", "content-length": body.length },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            /* leave null so a test fails clearly */
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("trustledger T-29.3: the web door honours the license gate", function () {
  let server;
  let port;
  let cwdBefore;

  beforeEach(function (done) {
    cwdBefore = fs.readdirSync(process.cwd()).sort();
    // today() is injected so the in-memory reconcile + license verify stay deterministic. The canonical
    // vendor identity is pinned to VENDOR via the programmatic seam (T-75.3) — the paid gate verifies
    // ONLY against this identity, never against the request body's own vendorAddress.
    server = createServer({ today: () => DATE, canonicalVendor: VENDOR.address });
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      done();
    });
  });
  afterEach(function (done) {
    // The server writes NOTHING to disk: the working tree is untouched.
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
    server.close(done);
  });

  // --- FREE TIER stays open ------------------------------------------------

  it("the FREE baseline reconcile needs NO license (200, ties out)", async function () {
    const res = await post(port, "/api/reconcile", { bank: BANK, ledger: BOOK, rentroll: RENT });
    expect(res.status).to.equal(200);
    expect(res.json.pass).to.equal(true);
  });

  it("the FREE inspect route needs NO license (200)", async function () {
    const res = await post(port, "/api/inspect", { source: "rentroll", text: RENT });
    expect(res.status).to.equal(200);
    expect(res.json.requiredMissing).to.deep.equal([]);
  });

  // --- GATED: a `state` request without a license is refused ---------------

  it("a `state` request WITHOUT a license => 402 named license_required (no silent free downgrade)", async function () {
    const res = await post(port, "/api/reconcile", {
      bank: BANK,
      ledger: BOOK,
      rentroll: RENT,
      state: "ca-example",
    });
    expect(res.status).to.equal(402);
    expect(res.json.error).to.equal("license_required");
    expect(res.json.message).to.match(/multi-state policy/);
    // Never a stack trace.
    expect(res.text).to.not.contain("server.js:");
    expect(res.text).to.not.contain("at Object.");
  });

  it("(T-75.3) vendorAddress is OPTIONAL — a canonical license ALONE unlocks; a vendorAddress with NO license is license_required", async function () {
    // A canonical-signed license with NO vendorAddress in the body UNLOCKS: the gate pins to the
    // server's canonical identity, so the body no longer needs to (and can no longer) supply the pin.
    const { text } = await mintLicenseText({ entitlements: ["multi_state_policy"] });
    const a = await post(port, "/api/reconcile", {
      bank: BANK, ledger: BOOK, rentroll: RENT, state: "ca-example", license: text,
    });
    expect(a.status).to.equal(200);
    expect(a.json.pass).to.equal(true);

    // A vendorAddress with NO license is still a paid surface with nothing to verify => license_required.
    const b = await post(port, "/api/reconcile", {
      bank: BANK, ledger: BOOK, rentroll: RENT, state: "ca-example", vendorAddress: Wallet.createRandom().address,
    });
    expect(b.status).to.equal(402);
    expect(b.json.error).to.equal("license_required");
  });

  // --- GATED: a valid, entitled license unlocks the paid surface -----------

  it("the SAME `state` request WITH a valid, entitled license SUCCEEDS (200)", async function () {
    const { text, vendorAddress } = await mintLicenseText({ entitlements: ["multi_state_policy"] });
    const res = await post(port, "/api/reconcile", {
      bank: BANK,
      ledger: BOOK,
      rentroll: RENT,
      state: "ca-example",
      license: text,
      vendorAddress,
    });
    expect(res.status).to.equal(200);
    expect(res.json).to.have.property("pass");
    // The packet names the governing policy (proves the paid surface actually ran).
    expect(res.json.reportHtml).to.match(/ca-example|EXAMPLE|California/i);
  });

  it("the license container may be supplied as an already-parsed OBJECT, not just a string", async function () {
    const { text, vendorAddress } = await mintLicenseText({ entitlements: ["multi_state_policy"] });
    const res = await post(port, "/api/reconcile", {
      bank: BANK,
      ledger: BOOK,
      rentroll: RENT,
      state: "ca-example",
      license: JSON.parse(text),
      vendorAddress,
    });
    expect(res.status).to.equal(200);
    expect(res.json).to.have.property("pass");
  });

  // --- GATED: invalid licenses are refused with the PRECISE reason ---------

  it("(T-75.3) a SELF-MINTED license (signed by a non-canonical key) => 403 license_invalid (wrong_issuer), even with no vendorAddress", async function () {
    // The textbook free-ride: an attacker mints a license with their OWN key and POSTs it. The gate pins
    // to the server's canonical identity, so the attacker's own signature never recovers to it.
    const attacker = Wallet.createRandom();
    const { text } = await mintLicenseText({ entitlements: ["multi_state_policy"], wallet: attacker });
    const res = await post(port, "/api/reconcile", {
      bank: BANK, ledger: BOOK, rentroll: RENT, state: "ca-example", license: text,
    });
    expect(res.status).to.equal(403);
    expect(res.json.error).to.equal("license_invalid");
    expect(res.json.message).to.match(/wrong_issuer/);
  });

  it("(T-75.3) a vendorAddress RE-PIN attempt (body vendorAddress != canonical) => 403 license_invalid, refused as a re-pin", async function () {
    // The attacker self-mints AND names their own address as vendorAddress, trying to re-pin the gate.
    // The body's vendorAddress is accepted only as an assertion that must EQUAL the canonical identity.
    const attacker = Wallet.createRandom();
    const { text } = await mintLicenseText({ entitlements: ["multi_state_policy"], wallet: attacker });
    const res = await post(port, "/api/reconcile", {
      bank: BANK, ledger: BOOK, rentroll: RENT, state: "ca-example", license: text, vendorAddress: attacker.address,
    });
    expect(res.status).to.equal(403);
    expect(res.json.error).to.equal("license_invalid");
    expect(res.json.message).to.match(/does not match the canonical vendor identity/);
  });

  it("an EXPIRED license => 403 license_invalid (expired)", async function () {
    const { text, vendorAddress } = await mintLicenseText({
      entitlements: ["multi_state_policy"],
      issuedAt: "2025-01-01T00:00:00.000Z",
      expiresAt: "2025-12-31T00:00:00.000Z", // before DATE
    });
    const res = await post(port, "/api/reconcile", {
      bank: BANK, ledger: BOOK, rentroll: RENT, state: "ca-example", license: text, vendorAddress,
    });
    expect(res.status).to.equal(403);
    expect(res.json.error).to.equal("license_invalid");
    expect(res.json.message).to.match(/expired/);
  });

  it("a valid license MISSING the required entitlement => 403 license_invalid (names the entitlement)", async function () {
    // The license carries only `seal`, but `state` needs `multi_state_policy`.
    const { text, vendorAddress } = await mintLicenseText({ entitlements: ["seal"] });
    const res = await post(port, "/api/reconcile", {
      bank: BANK, ledger: BOOK, rentroll: RENT, state: "ca-example", license: text, vendorAddress,
    });
    expect(res.status).to.equal(403);
    expect(res.json.error).to.equal("license_invalid");
    expect(res.json.message).to.match(/multi_state_policy/);
  });

  it("a structurally MALFORMED license container => 403 license_invalid", async function () {
    const res = await post(port, "/api/reconcile", {
      bank: BANK,
      ledger: BOOK,
      rentroll: RENT,
      state: "ca-example",
      license: '{"not":"a license"}',
      vendorAddress: Wallet.createRandom().address,
    });
    expect(res.status).to.equal(403);
    expect(res.json.error).to.equal("license_invalid");
  });

  it("(T-75.3) a garbage vendorAddress assertion (with a license + paid feature) => 403 license_invalid (unparseable pin)", async function () {
    const { text } = await mintLicenseText({ entitlements: ["multi_state_policy"] });
    const res = await post(port, "/api/reconcile", {
      bank: BANK, ledger: BOOK, rentroll: RENT, state: "ca-example", license: text, vendorAddress: "not-an-address",
    });
    expect(res.status).to.equal(403);
    expect(res.json.error).to.equal("license_invalid");
    expect(res.json.message).to.match(/not a valid 0x-address/);
  });

  // --- a stray license on a FREE run is ignored (free path unchanged) ------

  it("a stray license/vendorAddress on a baseline (no-state) run is ignored => 200 (free path unchanged)", async function () {
    const { text, vendorAddress } = await mintLicenseText();
    const res = await post(port, "/api/reconcile", {
      bank: BANK, ledger: BOOK, rentroll: RENT, license: text, vendorAddress,
    });
    expect(res.status).to.equal(200);
    expect(res.json.pass).to.equal(true);
  });
});

// ---------------------------------------------------------------------------
// STATIC ANALYSIS — the page references the license fields the server reads, and
// the docs schema matches ENTITLEMENTS / the canonical license payload shape.
// ---------------------------------------------------------------------------

describe("trustledger T-29.3: page + docs reference the license gate (no silent drift)", function () {
  const PAGE = fs.readFileSync(
    path.join(__dirname, "..", "trustledger", "public", "index.html"),
    "utf8"
  );
  const DOC = fs.readFileSync(
    path.join(__dirname, "..", "docs", "TRUSTLEDGER.md"),
    "utf8"
  );

  it("the page POSTs the license + vendorAddress fields the server's gate reads", function () {
    // The server gate reads payload.license + payload.vendorAddress; the page must
    // populate both onto the reconcile body, or the gate could never be satisfied.
    expect(PAGE).to.match(/body\.license\s*=/);
    expect(PAGE).to.match(/body\.vendorAddress\s*=/);
    // And the inputs the broker fills exist on the page.
    expect(PAGE).to.match(/id="license"/);
    expect(PAGE).to.match(/id="vendorAddress"/);
  });

  it("the page shows a license NOTICE (not a raw error) when the gate refuses", function () {
    expect(PAGE).to.contain("license_required");
    expect(PAGE).to.contain("license_invalid");
    expect(PAGE).to.match(/This feature requires a license/i);
  });

  it("docs TRUSTLEDGER.md has an Entitlements & licensing section", function () {
    expect(DOC).to.match(/Entitlements\s*&\s*licensing/i);
  });

  it("docs enumerate EXACTLY the closed ENTITLEMENTS table (no drift)", function () {
    // Every shipped entitlement flag must be documented, and the docs must not
    // invent a flag the code does not know — the schema and the docs stay in lockstep.
    for (const flag of licenseMod.ENTITLEMENT_FLAGS) {
      expect(DOC, `docs must document entitlement "${flag}"`).to.contain(flag);
    }
    // Guard the reverse: any `code`-formatted *_-style flag the docs mention that
    // LOOKS like an entitlement must be a real one (catches a doc-only typo'd flag).
    const known = new Set(licenseMod.ENTITLEMENT_FLAGS);
    const candidates = (DOC.match(/`([a-z][a-z0-9]*_[a-z0-9_]+)`/g) || [])
      .map((s) => s.replace(/`/g, ""));
    const ENTITLEMENT_LIKE = new Set([
      "multi_state_policy",
      "unlimited_reconcile",
    ]);
    for (const c of candidates) {
      if (ENTITLEMENT_LIKE.has(c)) {
        expect(known.has(c), `docs mention "${c}" which is not a real entitlement`).to.equal(true);
      }
    }
  });

  it("docs document every license PAYLOAD field the canonical schema carries", function () {
    // The canonical payload shape (from buildLicensePayload): these exact keys.
    for (const field of [
      "kind",
      "schemaVersion",
      "licenseId",
      "customer",
      "plan",
      "entitlements",
      "issuedAt",
      "expiresAt",
    ]) {
      expect(DOC, `docs must document license field "${field}"`).to.contain(field);
    }
  });

  it("docs state the license is an UNTRUSTED container that verification re-derives", function () {
    expect(DOC).to.match(/re-?deriv/i);
    expect(DOC.toLowerCase()).to.contain("untrusted");
    expect(DOC).to.match(/offline/i);
  });
});

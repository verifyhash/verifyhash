"use strict";

// test/trustledger.canonical-vendor.test.js — T-75.3 acceptance for TrustLedger's OWN two paid gates.
//
// EPIC-75 closed the self-mint revenue leak on the evidence/agent gates. This suite closes the SAME leak
// on the lead income product's two live paid surfaces:
//   * the CLI reconcile/value-proof gate (trustledger/cli.js `gateReconcile`), and
//   * the HOSTED web door (trustledger/door-core.js `gatePayload`, driven through the real http server).
//
// THE LEAK (revenue-only — NOT impersonation: an attacker's seals are still signed by their own key):
// both gates used to verify the supplied license against WHATEVER address the caller passed as
// `--vendor` / `vendorAddress`, so anyone could self-mint a license with their own key, name their own
// address, and unlock the paid multi-state-policy / seal surface for free.
//
// What these prove (the acceptance criteria):
//   (1) both gates verify against a COMMITTED canonical vendor identity — the published verifyhash
//       address, single-sourced in cli/core/vendor-identity.js and mirrored into the TrustLedger cfg;
//   (2) the SELF-MINT attack is refused BY NAME on BOTH gates: a caller-supplied vendor that differs
//       from the canonical identity is a named refusal (it can NOT re-pin the gate), and a license minted
//       by a NON-canonical key is the named `wrong_issuer` reject — nothing written / no unlock either way;
//   (3) a license minted by the CANONICAL key still unlocks — via the committed default's self-hosting
//       stand-ins: the programmatic io.canonicalVendor / createServer canonicalVendor seam AND the
//       VH_CANONICAL_VENDOR operator config channel (argv can never do this);
//   (4) the OFFLINE verify path for already-signed licenses is UNCHANGED: the read-only
//       `vh trust license verify <file> --vendor <addr>` inspection verb still answers "did THIS key sign
//       it?" for ANY address — byte-identical verdicts regardless of the canonical config;
//   (5) the resolveVendorPin / resolveCanonicalVendor primitives are strict and fail-closed.
//
// Offline; no new dependency. Every key is an EPHEMERAL Wallet.createRandom() (never a real key); the
// ONLY real-identity assertion is address equality against the committed PUBLIC constant.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { Wallet, getAddress } = require("ethers");

const { cmdTrust, EXIT } = require("../trustledger/cli");
const tlLicense = require("../trustledger/license");
const coreLicense = require("../cli/core/license");
const vendorIdentity = require("../cli/core/vendor-identity");
const { createServer } = require("../trustledger/server");

const FIX = path.join(__dirname, "..", "trustledger", "fixtures", "e2e");
const BANK = path.join(FIX, "bank.csv");
const BOOK = path.join(FIX, "quickbooks.csv");
const RENT = path.join(FIX, "rentroll.csv");
const BANK_T = fs.readFileSync(BANK, "utf8");
const BOOK_T = fs.readFileSync(BOOK, "utf8");
const RENT_T = fs.readFileSync(RENT, "utf8");

// The PUBLISHED verifyhash vendor identity. A silent drift would re-open the leak (or brick real
// customers' licenses), so it is pinned here.
const PUBLISHED_VENDOR = "0x7cb4d3DC6C52996B6386473Bfb32f898263412f7";

const DATE = "2026-06-24"; // pinned report date / verify clock

function capture(extra = {}) {
  const out = [];
  const err = [];
  return Object.assign(
    {
      write: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      today: () => DATE,
      out: () => out.join(""),
      err: () => err.join(""),
    },
    extra
  );
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
            /* leave null */
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("trustledger T-75.3: both paid gates pin to the CANONICAL vendor identity", function () {
  let tmpDirs;
  let cwdBefore;
  let envBefore;
  beforeEach(function () {
    tmpDirs = [];
    cwdBefore = fs.readdirSync(process.cwd()).sort();
    // The committed-default assertions depend on the operator config channel being UNSET.
    envBefore = process.env[tlLicense.CANONICAL_VENDOR_ENV];
    delete process.env[tlLicense.CANONICAL_VENDOR_ENV];
  });
  afterEach(function () {
    if (envBefore === undefined) delete process.env[tlLicense.CANONICAL_VENDOR_ENV];
    else process.env[tlLicense.CANONICAL_VENDOR_ENV] = envBefore;
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "tl-t753-"));
    tmpDirs.push(d);
    return d;
  }

  // Mint a signed TrustLedger license (ephemeral key), write it to a temp file, return { file, text,
  // vendor }. `entitlements` and `wallet` are overridable.
  async function mintLicense({ entitlements = ["multi_state_policy", "seal"], wallet } = {}) {
    const w = wallet || Wallet.createRandom();
    const container = await tlLicense.buildLicense(
      {
        licenseId: "TL-T753-1",
        customer: "Canonical Pin Test Co",
        plan: "pro",
        entitlements,
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
      w
    );
    const dir = mkTmp();
    const file = path.join(dir, "t753.vhlicense.json");
    const text = tlLicense.serializeSignedLicense(container);
    fs.writeFileSync(file, text);
    return { file, text, vendor: w.address, wallet: w };
  }

  // =======================================================================
  // (1) The canonical identity is a COMMITTED constant — the published one.
  // =======================================================================

  it("(1) the committed constant IS the published vendor identity, mirrored into the TrustLedger cfg", function () {
    expect(tlLicense.CANONICAL_VENDOR_ADDRESS).to.equal(PUBLISHED_VENDOR);
    expect(vendorIdentity.VERIFYHASH_VENDOR_ADDRESS).to.equal(PUBLISHED_VENDOR);
    // With no override/env, the pin the gate would use is the checksummed committed default.
    expect(tlLicense.resolveVendorPin()).to.equal(PUBLISHED_VENDOR);
    expect(tlLicense.resolveCanonicalVendor({})).to.equal(PUBLISHED_VENDOR);
    expect(tlLicense.CANONICAL_VENDOR_ENV).to.equal("VH_CANONICAL_VENDOR");
  });

  // =======================================================================
  // (2) THE CLI reconcile gate — the self-mint attack refused by name.
  // =======================================================================

  it("(2) CLI: the exact old attack — self-minted license + --vendor naming the attacker's own key — is a NAMED usage refusal, nothing written", async function () {
    const { file, vendor } = await mintLicense(); // ephemeral key != committed canonical default
    const out = mkTmp();
    const io = capture(); // committed default canonical (env unset, no io.canonicalVendor)
    const code = cmdTrust(
      ["reconcile", BANK, BOOK, RENT, "--date", DATE, "--out", out, "--state", "ca-example", "--seal", "--license", file, "--vendor", vendor],
      io
    );
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/does not match the canonical vendor identity/);
    // The gate fires before any packet work: nothing written.
    expect(fs.readdirSync(out)).to.deep.equal([]);
  });

  it("(2) CLI: a self-minted license WITHOUT --vendor is the NAMED wrong_issuer gate-fail against the committed default, nothing written", async function () {
    const { file } = await mintLicense();
    const out = mkTmp();
    const io = capture();
    const code = cmdTrust(
      ["reconcile", BANK, BOOK, RENT, "--date", DATE, "--out", out, "--seal", "--license", file],
      io
    );
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/reason: wrong_issuer/);
    expect(io.err()).to.match(/self-minted license signed by any other key is refused/);
    expect(fs.readdirSync(out)).to.deep.equal([]);
  });

  // =======================================================================
  // (3) A canonical-key license still unlocks — via the self-hosting seams.
  // =======================================================================

  it("(3) CLI: a canonical-key license unlocks --state/--seal (programmatic io.canonicalVendor seam; matching --vendor accepted in any casing)", async function () {
    const canonical = Wallet.createRandom();
    const { file } = await mintLicense({ entitlements: ["multi_state_policy", "seal"], wallet: canonical });
    const out = mkTmp();
    const io = capture({ canonicalVendor: canonical.address });
    const code = cmdTrust(
      ["reconcile", BANK, BOOK, RENT, "--date", DATE, "--out", out, "--state", "ca-example", "--seal",
        "--license", file, "--vendor", canonical.address.toLowerCase()],
      io
    );
    expect(code).to.equal(EXIT.PASS);
    expect(fs.existsSync(path.join(out, `reconciliation-${DATE}-seal.json`))).to.equal(true);
  });

  it("(3) CLI: the VH_CANONICAL_VENDOR operator config channel works (self-hosting), with NO --vendor and NO io seam", async function () {
    const operator = Wallet.createRandom();
    const { file } = await mintLicense({ entitlements: ["seal"], wallet: operator });
    const out = mkTmp();
    process.env[tlLicense.CANONICAL_VENDOR_ENV] = operator.address;
    const io = capture(); // no io.canonicalVendor — resolution falls to the env channel
    const code = cmdTrust(
      ["reconcile", BANK, BOOK, RENT, "--date", DATE, "--out", out, "--seal", "--license", file],
      io
    );
    expect(code).to.equal(EXIT.PASS);
    expect(fs.existsSync(path.join(out, `reconciliation-${DATE}-seal.json`))).to.equal(true);
  });

  // =======================================================================
  // (2)+(3) THE HOSTED WEB DOOR — the textbook "free-ride a hosted vendor".
  // =======================================================================

  it("(2) WEB: a self-minted license POSTed to a HOSTED vendor (committed default) is 403 wrong_issuer — no unlock", async function () {
    const { text } = await mintLicense({ entitlements: ["multi_state_policy"] }); // attacker key
    const server = createServer({ today: () => DATE }); // committed-default canonical (env unset)
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = server.address().port;
      const res = await post(port, "/api/reconcile", {
        bank: BANK_T, ledger: BOOK_T, rentroll: RENT_T, state: "ca-example", text: undefined, license: text,
      });
      expect(res.status).to.equal(403);
      expect(res.json.error).to.equal("license_invalid");
      expect(res.json.message).to.match(/wrong_issuer/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("(2) WEB: a vendorAddress RE-PIN attempt (body vendorAddress != the server's canonical) is 403, refused as a re-pin", async function () {
    const attacker = Wallet.createRandom();
    const { text } = await mintLicense({ entitlements: ["multi_state_policy"], wallet: attacker });
    // Server pinned to a DIFFERENT canonical vendor via the seam.
    const server = createServer({ today: () => DATE, canonicalVendor: Wallet.createRandom().address });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = server.address().port;
      const res = await post(port, "/api/reconcile", {
        bank: BANK_T, ledger: BOOK_T, rentroll: RENT_T, state: "ca-example", license: text, vendorAddress: attacker.address,
      });
      expect(res.status).to.equal(403);
      expect(res.json.error).to.equal("license_invalid");
      expect(res.json.message).to.match(/does not match the canonical vendor identity/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("(3) WEB: a canonical-key license unlocks the hosted paid surface when the server is pinned to that identity", async function () {
    const canonical = Wallet.createRandom();
    const { text } = await mintLicense({ entitlements: ["multi_state_policy"], wallet: canonical });
    const server = createServer({ today: () => DATE, canonicalVendor: canonical.address });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = server.address().port;
      // Unlocks with NO vendorAddress in the body (the gate pins server-side, not from the request).
      const res = await post(port, "/api/reconcile", {
        bank: BANK_T, ledger: BOOK_T, rentroll: RENT_T, state: "ca-example", license: text,
      });
      expect(res.status).to.equal(200);
      expect(res.json.pass).to.equal(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  // =======================================================================
  // (4) The read-only inspection verb is UNCHANGED — never consults the pin.
  // =======================================================================

  it("(4) the OFFLINE `license verify --vendor <addr>` inspection verb is unchanged (byte-identical verdict regardless of canonical config)", async function () {
    const { file, vendor } = await mintLicense({ entitlements: ["seal"] });

    // With the operator env UNSET, verify against the true signer => VALID; against a wrong key => wrong_issuer.
    const ioA = capture();
    expect(cmdTrust(["license", "verify", file, "--vendor", vendor, "--now", `${DATE}T12:00:00.000Z`, "--json"], ioA)).to.equal(EXIT.PASS);
    const wrong = Wallet.createRandom().address;
    const ioW = capture();
    expect(cmdTrust(["license", "verify", file, "--vendor", wrong, "--now", `${DATE}T12:00:00.000Z`, "--json"], ioW)).to.equal(EXIT.FAIL);

    // Now set VH_CANONICAL_VENDOR to a THIRD, unrelated identity. The inspection verb must be COMPLETELY
    // unaffected — it answers "did THIS --vendor sign it?", it is not a gate and consults no canonical pin.
    process.env[tlLicense.CANONICAL_VENDOR_ENV] = Wallet.createRandom().address;
    const ioA2 = capture();
    expect(cmdTrust(["license", "verify", file, "--vendor", vendor, "--now", `${DATE}T12:00:00.000Z`, "--json"], ioA2)).to.equal(EXIT.PASS);
    const ioW2 = capture();
    expect(cmdTrust(["license", "verify", file, "--vendor", wrong, "--now", `${DATE}T12:00:00.000Z`, "--json"], ioW2)).to.equal(EXIT.FAIL);

    // Byte-identical verdicts with and without the env config set.
    expect(ioA2.out()).to.equal(ioA.out());
    expect(ioW2.out()).to.equal(ioW.out());
    expect(JSON.parse(ioW.out()).reason).to.equal("wrong_issuer");
  });

  // =======================================================================
  // (5) The primitives are strict + fail-closed.
  // =======================================================================

  it("(5) tlLicense.resolveVendorPin + resolveCanonicalVendor: strict, fail-closed, self-host override honored", function () {
    // No caller pin => the committed checksummed default. A matching pin (any casing) => the same.
    expect(tlLicense.resolveVendorPin()).to.equal(PUBLISHED_VENDOR);
    expect(tlLicense.resolveVendorPin(PUBLISHED_VENDOR.toLowerCase())).to.equal(PUBLISHED_VENDOR);

    // A DIFFERENT caller pin against the committed default is the named re-pin refusal.
    expect(() => tlLicense.resolveVendorPin(Wallet.createRandom().address)).to.throw(
      tlLicense.LicenseError,
      /cannot re-pin an entitlement gate/
    );
    // A garbage caller pin is a named error.
    expect(() => tlLicense.resolveVendorPin("garbage")).to.throw(
      tlLicense.LicenseError,
      /not a valid 0x-address/
    );

    // The self-host override: canonicalVendor arg re-points the pin (this is NOT argv — it is the seam a
    // self-hosted operator's config resolves to). A caller pin must then EQUAL that override.
    const op = Wallet.createRandom();
    expect(tlLicense.resolveVendorPin(undefined, op.address)).to.equal(getAddress(op.address));
    expect(tlLicense.resolveVendorPin(op.address.toLowerCase(), op.address)).to.equal(getAddress(op.address));
    expect(() => tlLicense.resolveVendorPin(Wallet.createRandom().address, op.address)).to.throw(
      tlLicense.LicenseError,
      /does not match the canonical vendor identity/
    );

    // resolveCanonicalVendor precedence: io.canonicalVendor override > env > committed default.
    const prev = process.env[tlLicense.CANONICAL_VENDOR_ENV];
    try {
      delete process.env[tlLicense.CANONICAL_VENDOR_ENV];
      expect(tlLicense.resolveCanonicalVendor({})).to.equal(PUBLISHED_VENDOR);
      process.env[tlLicense.CANONICAL_VENDOR_ENV] = "0xAAA";
      expect(tlLicense.resolveCanonicalVendor({})).to.equal("0xAAA");
      expect(tlLicense.resolveCanonicalVendor({ canonicalVendor: "0xBBB" })).to.equal("0xBBB");
    } finally {
      if (prev === undefined) delete process.env[tlLicense.CANONICAL_VENDOR_ENV];
      else process.env[tlLicense.CANONICAL_VENDOR_ENV] = prev;
    }
  });
});

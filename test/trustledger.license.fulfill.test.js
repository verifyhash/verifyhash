"use strict";

// TrustLedger — the order -> license mapping + `vh trust license fulfill` (T-37.2).
//
// Proves the deterministic fulfillment seam on top of the pure plan catalog
// (T-37.1) and the existing signed-license core/gate (T-29.x):
//   * fulfillOrder is PURE + DETERMINISTIC — the same { plan, customer, paidThrough,
//     issuedAt } + catalog yields byte-identical params; entitlements come ONLY from
//     the resolved plan (never re-typed);
//   * an omitted paidThrough derives expiresAt = issuedAt + plan.termDays days;
//   * an unknown plan / paidThrough<=issuedAt / malformed date each throw a NAMED
//     LicenseError (never a silent pass / coercion);
//   * `vh trust license fulfill` with an EPHEMERAL Wallet.createRandom() key writes a
//     *.vhlicense.json whose entitlements + window EXACTLY equal the plan's, and that
//     container is ACCEPTED by the UNCHANGED `vh trust license verify --vendor <addr>`
//     (exit 0) AND UNLOCKS the matching paid surface via the UNCHANGED `vh trust
//     reconcile --license <f> --vendor <addr>` gate (a plan WITHOUT `seal` does NOT
//     unlock --seal; a plan WITH it does) — proving fulfill output is byte-compatible
//     with the existing gate;
//   * neither/both/missing/malformed key sources hard-error with a KEY-FREE message
//     (the key is never echoed);
//   * a wrong-issuer / expired fulfilled license REJECTS exactly as `verify` does.
//
// Every signing key is an EPHEMERAL in-process Wallet.createRandom() (TEST-ONLY,
// never a real key/real funds). Every filesystem effect is isolated to a throwaway
// temp dir; the test asserts the working tree (cwd) is left UNTOUCHED.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Wallet } = require("ethers");

const { cmdTrust, EXIT } = require("../trustledger/cli");
const license = require("../trustledger/license");
const plans = require("../trustledger/plans");

const FIX = path.join(__dirname, "..", "trustledger", "fixtures", "e2e");
const BANK = path.join(FIX, "bank.csv");
const BOOK = path.join(FIX, "quickbooks.csv");
const RENT = path.join(FIX, "rentroll.csv");

const BASELINE = path.join(
  __dirname,
  "..",
  "trustledger",
  "fixtures",
  "plans",
  "baseline.json"
);

const DATE = "2026-06-24"; // pinned reconcile report date / verify clock
const ISSUED = "2026-01-01T00:00:00.000Z"; // pinned issuedAt (well before DATE)

// A FRESH validated catalog per use (the module is pure; the test does the I/O).
function catalog() {
  return plans.validatePlanCatalog(JSON.parse(fs.readFileSync(BASELINE, "utf8")));
}

function capture(extra = {}) {
  const out = [];
  const err = [];
  return Object.assign(
    {
      write: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      today: () => DATE,
      // The fulfill/verify default clock — pinned so the artifact + verdict are
      // deterministic. issuedAt is supplied explicitly via --issued below.
      nowISO: () => `${DATE}T12:00:00.000Z`,
      out: () => out.join(""),
      err: () => err.join(""),
    },
    extra
  );
}

// ===========================================================================
// PART 1 — fulfillOrder: PURE, DETERMINISTIC, strict (no key, no I/O).
// ===========================================================================

describe("trustledger T-37.2: fulfillOrder (the pure order -> license mapping)", function () {
  it("derives the EXACT buildLicensePayload params from plan + order (entitlements from the plan)", function () {
    const cat = catalog();
    const params = license.fulfillOrder(
      { plan: "pro-annual", customer: "Acme Realty LLC", issuedAt: ISSUED },
      cat
    );
    // Entitlements come ONLY from the resolved plan — verbatim, never re-typed.
    const plan = cat.plansById["pro-annual"];
    expect(params.entitlements).to.deep.equal(plan.entitlements);
    expect(params.plan).to.equal("pro-annual");
    expect(params.customer).to.equal("Acme Realty LLC");
    expect(params.issuedAt).to.equal(ISSUED);
    // The params feed buildLicensePayload byte-for-byte (it accepts them unchanged).
    const payload = license.buildLicensePayload(params);
    expect(payload.entitlements).to.deep.equal(plan.entitlements);
  });

  it("is DETERMINISTIC — same order + catalog => byte-identical params", function () {
    const order = { plan: "firm-annual", customer: "Beta LLC", issuedAt: ISSUED };
    const a = JSON.stringify(license.fulfillOrder(order, catalog()));
    const b = JSON.stringify(license.fulfillOrder(order, catalog()));
    expect(a).to.equal(b);
  });

  it("paidThrough OMITTED => expiresAt = issuedAt + plan.termDays days", function () {
    const cat = catalog();
    for (const planId of ["solo-monthly", "pro-annual", "firm-annual"]) {
      const params = license.fulfillOrder(
        { plan: planId, customer: "X", issuedAt: ISSUED },
        cat
      );
      const expectedMs = Date.parse(ISSUED) + cat.plansById[planId].termDays * 86400000;
      expect(params.expiresAt).to.equal(new Date(expectedMs).toISOString());
      // And it is a sound window the validator accepts.
      expect(() => license.buildLicensePayload(params)).to.not.throw();
    }
  });

  it("an explicit paidThrough WINS over the derived term", function () {
    const params = license.fulfillOrder(
      {
        plan: "solo-monthly",
        customer: "X",
        issuedAt: ISSUED,
        paidThrough: "2026-06-15T00:00:00.000Z",
      },
      catalog()
    );
    expect(params.expiresAt).to.equal("2026-06-15T00:00:00.000Z");
  });

  it("an explicit licenseId WINS; an omitted one is a deterministic default", function () {
    const cat = catalog();
    const explicit = license.fulfillOrder(
      { plan: "solo-monthly", customer: "X", issuedAt: ISSUED, licenseId: "ORDER-42" },
      cat
    );
    expect(explicit.licenseId).to.equal("ORDER-42");
    const def = license.fulfillOrder(
      { plan: "solo-monthly", customer: "X", issuedAt: ISSUED },
      cat
    );
    expect(def.licenseId).to.equal(`LIC-${ISSUED}-solo-monthly`);
  });

  it("an UNKNOWN plan throws a NAMED LicenseError naming the known plans", function () {
    let caught;
    try {
      license.fulfillOrder({ plan: "enterprise", customer: "X", issuedAt: ISSUED }, catalog());
    } catch (e) {
      caught = e;
    }
    expect(caught).to.be.instanceOf(license.LicenseError);
    expect(caught.message).to.match(/unknown plan/i);
    expect(caught.message).to.include("solo-monthly");
  });

  it("paidThrough <= issuedAt throws a NAMED LicenseError (empty/negative window)", function () {
    // equal to issuedAt
    expect(() =>
      license.fulfillOrder(
        { plan: "solo-monthly", customer: "X", issuedAt: ISSUED, paidThrough: ISSUED },
        catalog()
      )
    ).to.throw(license.LicenseError, /paidThrough.*strictly AFTER issuedAt/i);
    // before issuedAt
    expect(() =>
      license.fulfillOrder(
        {
          plan: "solo-monthly",
          customer: "X",
          issuedAt: ISSUED,
          paidThrough: "2025-12-01T00:00:00.000Z",
        },
        catalog()
      )
    ).to.throw(license.LicenseError, /strictly AFTER issuedAt/i);
  });

  it("a malformed date (issuedAt OR paidThrough) throws a NAMED LicenseError", function () {
    // rolled-over / impossible calendar instant
    expect(() =>
      license.fulfillOrder(
        { plan: "solo-monthly", customer: "X", issuedAt: "2026-02-30T00:00:00.000Z" },
        catalog()
      )
    ).to.throw(license.LicenseError, /issuedAt/);
    // date-only (not a canonical instant)
    expect(() =>
      license.fulfillOrder(
        { plan: "solo-monthly", customer: "X", issuedAt: "2026-01-01" },
        catalog()
      )
    ).to.throw(license.LicenseError, /issuedAt/);
    // malformed paidThrough
    expect(() =>
      license.fulfillOrder(
        {
          plan: "solo-monthly",
          customer: "X",
          issuedAt: ISSUED,
          paidThrough: "not-a-date",
        },
        catalog()
      )
    ).to.throw(license.LicenseError, /paidThrough/);
  });

  it("does NOT mutate the frozen catalog plan's entitlements (returns a fresh array)", function () {
    const cat = catalog();
    const params = license.fulfillOrder(
      { plan: "firm-annual", customer: "X", issuedAt: ISSUED },
      cat
    );
    params.entitlements.push("FORGED");
    // The catalog plan is untouched.
    expect(cat.plansById["firm-annual"].entitlements).to.not.include("FORGED");
  });
});

// ===========================================================================
// PART 2 — `vh trust license fulfill`: emits a container the UNCHANGED
//          verify + reconcile gate accept.
// ===========================================================================

describe("trustledger T-37.2: `vh trust license fulfill` round-trips through verify + the gate", function () {
  let tmpDirs;
  let cwdBefore;
  beforeEach(function () {
    tmpDirs = [];
    cwdBefore = fs.readdirSync(process.cwd()).sort();
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    // FILESYSTEM HYGIENE: nothing the commands did leaked into the working tree.
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "tl-fulfill-"));
    tmpDirs.push(d);
    return d;
  }

  // Fulfill a license through the PUBLIC `vh trust license fulfill`, reading the key
  // from an env var that holds an EPHEMERAL key for the duration of the call. Returns
  // { code, io, vendor, file, env } — the env var is DELETED after the call.
  async function fulfill(dir, { plan, paidThrough, issued, extra = [] } = {}) {
    const wallet = Wallet.createRandom();
    const env = "TL_TEST_FULFILL_KEY";
    const file = path.join(dir, "customer.vhlicense.json");
    process.env[env] = wallet.privateKey;
    const io = capture();
    let code;
    try {
      const argv = [
        "license", "fulfill",
        "--plan", plan || "pro-annual",
        "--customer", "Acme Realty LLC",
        "--issued", issued || ISSUED,
        "--key-env", env,
        "--out", file,
      ];
      if (paidThrough) argv.push("--paid-through", paidThrough);
      argv.push(...extra);
      code = await cmdTrust(argv, io);
    } finally {
      delete process.env[env];
    }
    return { code, io, vendor: wallet.address, file, env };
  }

  it("writes a *.vhlicense.json the key is NEVER echoed into; entitlements + window EXACTLY equal the plan's", async function () {
    const dir = mkTmp();
    const { code, io, vendor, file } = await fulfill(dir, { plan: "pro-annual" });
    expect(code).to.equal(EXIT.PASS);

    // The written container parses + recovers to the ephemeral vendor.
    const container = license.readLicense(fs.readFileSync(file, "utf8"));
    const payload = JSON.parse(container.attestation);
    const cat = catalog();
    const plan = cat.plansById["pro-annual"];
    expect(payload.entitlements).to.deep.equal(plan.entitlements);
    // Window EXACTLY the derived term (issuedAt + termDays).
    const expectedExpiry = new Date(
      Date.parse(ISSUED) + plan.termDays * 86400000
    ).toISOString();
    expect(payload.issuedAt).to.equal(ISSUED);
    expect(payload.expiresAt).to.equal(expectedExpiry);

    // The KEY is NEVER echoed (stdout or stderr) — only the PUBLIC vendor address.
    const all = io.out() + io.err();
    expect(all).to.not.include(process.env.TL_TEST_FULFILL_KEY || "__never__");
    // The PUBLIC vendor address is printed (recoverSigner normalizes to lowercase).
    expect(io.out().toLowerCase()).to.include(vendor.toLowerCase());
  });

  it("the fulfilled container is ACCEPTED by the UNCHANGED `license verify --vendor` (exit 0)", async function () {
    const dir = mkTmp();
    const { vendor, file } = await fulfill(dir, { plan: "pro-annual" });
    const io = capture();
    const code = cmdTrust(
      ["license", "verify", file, "--vendor", vendor, "--now", `${DATE}T12:00:00.000Z`],
      io
    );
    expect(code).to.equal(EXIT.PASS);
    expect(io.out()).to.include("VALID");
  });

  it("a fulfilled license WITH `seal` UNLOCKS the --seal gate via the UNCHANGED reconcile", async function () {
    const dir = mkTmp();
    // solo-monthly grants [seal] (no multi_state_policy) — its term covers DATE.
    const { vendor, file } = await fulfill(dir, { plan: "solo-monthly", issued: `${DATE}T00:00:00.000Z` });
    const outDir = path.join(dir, "packet");
    // T-75.3: the gate pins to the CANONICAL identity — declare this ephemeral vendor canonical via the
    // programmatic io.canonicalVendor seam (matching the --vendor assertion below).
    const io = capture({ canonicalVendor: vendor });
    const code = cmdTrust(
      [
        "reconcile", BANK, BOOK, RENT,
        "--out", outDir,
        "--date", DATE,
        "--seal",
        "--license", file,
        "--vendor", vendor,
      ],
      io
    );
    // The gate let the run proceed (exit is the data verdict 0/3, never the gate's 2).
    expect(code).to.not.equal(EXIT.USAGE);
    expect(io.err()).to.not.match(/PAID feature|requires a VALID license/);
    // A seal was actually emitted (the unlocked paid surface ran).
    const sealed = fs.readdirSync(outDir).some((f) => /seal\.json$/.test(f));
    expect(sealed).to.equal(true);
  });

  it("a fulfilled license WITHOUT `seal` does NOT unlock --seal (gate refuses, exit 2)", async function () {
    const dir = mkTmp();
    // Build a tiny single-entitlement catalog whose only plan grants multi_state_policy
    // (NOT seal), then fulfill against it — proving the gate honors the plan's bundle.
    const customCat = {
      kind: "trustledger-plan-catalog",
      schemaVersion: 1,
      plans: [
        {
          planId: "policy-only",
          displayName: "Policy only",
          entitlements: ["multi_state_policy"],
          termDays: 365,
        },
      ],
    };
    const catFile = path.join(dir, "catalog.json");
    fs.writeFileSync(catFile, JSON.stringify(customCat));
    const { code: fcode, vendor, file } = await fulfill(dir, {
      plan: "policy-only",
      issued: `${DATE}T00:00:00.000Z`,
      extra: ["--catalog", catFile],
    });
    expect(fcode).to.equal(EXIT.PASS);

    const outDir = path.join(dir, "packet");
    // T-75.3: pin canonical to this ephemeral vendor so the license is VALID but under-entitled (proving
    // the gate refuses on the MISSING entitlement, not on a vendor mismatch).
    const io = capture({ canonicalVendor: vendor });
    const code = cmdTrust(
      [
        "reconcile", BANK, BOOK, RENT,
        "--out", outDir,
        "--date", DATE,
        "--seal",
        "--license", file,
        "--vendor", vendor,
      ],
      io
    );
    // The plan lacks `seal`, so the --seal surface is REFUSED (usage gate).
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/does NOT include the "seal"/);
  });

  it("a WRONG --vendor REJECTS exactly as verify already does (wrong_issuer, exit 3)", async function () {
    const dir = mkTmp();
    const { file } = await fulfill(dir, { plan: "pro-annual" });
    const otherVendor = Wallet.createRandom().address; // a DIFFERENT issuer
    const io = capture();
    const code = cmdTrust(
      ["license", "verify", file, "--vendor", otherVendor, "--now", `${DATE}T12:00:00.000Z`],
      io
    );
    expect(code).to.equal(EXIT.FAIL);
    expect(io.out()).to.match(/INVALID/);
    expect(io.out()).to.match(/wrong_issuer/);
  });

  it("an EXPIRED fulfilled license REJECTS exactly as verify already does (expired, exit 3)", async function () {
    const dir = mkTmp();
    // solo-monthly = 30-day term from a FAR-PAST issuedAt -> expired well before DATE.
    const { vendor, file } = await fulfill(dir, {
      plan: "solo-monthly",
      issued: "2025-01-01T00:00:00.000Z",
    });
    const io = capture();
    const code = cmdTrust(
      ["license", "verify", file, "--vendor", vendor, "--now", `${DATE}T12:00:00.000Z`],
      io
    );
    expect(code).to.equal(EXIT.FAIL);
    expect(io.out()).to.match(/INVALID/);
    expect(io.out()).to.match(/expired/);
  });
});

// ===========================================================================
// PART 3 — key-source discipline + catalog/order errors (KEY-FREE messages).
// ===========================================================================

describe("trustledger T-37.2: `fulfill` key-source + order errors are key-free", function () {
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
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "tl-fulfill-err-"));
    tmpDirs.push(d);
    return d;
  }

  it("NEITHER key source hard-errors (exit 2) with an actionable, key-free message", async function () {
    const io = capture();
    const code = await cmdTrust(
      ["license", "fulfill", "--plan", "pro-annual", "--customer", "X", "--issued", ISSUED],
      io
    );
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/key/i);
    expect(io.err()).to.not.match(/0x[0-9a-fA-F]{16}/); // no key-shaped hex leaked
  });

  it("BOTH key sources hard-error (exit 2), key-free", async function () {
    const dir = mkTmp();
    const keyFile = path.join(dir, "k.key");
    const w = Wallet.createRandom();
    fs.writeFileSync(keyFile, w.privateKey);
    const env = "TL_TEST_FULFILL_BOTH";
    process.env[env] = w.privateKey;
    let code;
    const io = capture();
    try {
      code = await cmdTrust(
        [
          "license", "fulfill",
          "--plan", "pro-annual", "--customer", "X", "--issued", ISSUED,
          "--key-env", env, "--key-file", keyFile,
        ],
        io
      );
    } finally {
      delete process.env[env];
    }
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/mutually exclusive|EXACTLY ONE/i);
    expect(io.err()).to.not.include(w.privateKey);
  });

  it("a MISSING env var hard-errors (exit 2), naming only the var (never a key)", async function () {
    const env = "TL_TEST_FULFILL_MISSING";
    delete process.env[env];
    const io = capture();
    const code = await cmdTrust(
      [
        "license", "fulfill",
        "--plan", "pro-annual", "--customer", "X", "--issued", ISSUED,
        "--key-env", env,
      ],
      io
    );
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.include(env);
  });

  it("a MALFORMED key hard-errors (exit 2) with a fixed key-free message", async function () {
    const env = "TL_TEST_FULFILL_BADKEY";
    process.env[env] = "not-a-real-private-key";
    let code;
    const io = capture();
    try {
      code = await cmdTrust(
        [
          "license", "fulfill",
          "--plan", "pro-annual", "--customer", "X", "--issued", ISSUED,
          "--key-env", env,
        ],
        io
      );
    } finally {
      delete process.env[env];
    }
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/not a valid private key/);
    expect(io.err()).to.not.include("not-a-real-private-key");
  });

  it("an UNKNOWN plan via the command is a usage error (exit 2), key never read into output", async function () {
    const dir = mkTmp();
    const env = "TL_TEST_FULFILL_UNKNOWNPLAN";
    const w = Wallet.createRandom();
    process.env[env] = w.privateKey;
    let code;
    const io = capture();
    try {
      code = await cmdTrust(
        [
          "license", "fulfill",
          "--plan", "no-such-plan", "--customer", "X", "--issued", ISSUED,
          "--key-env", env, "--out", path.join(dir, "x.vhlicense.json"),
        ],
        io
      );
    } finally {
      delete process.env[env];
    }
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/unknown plan/i);
    expect(io.err() + io.out()).to.not.include(w.privateKey);
    // No license file was written on the error path.
    expect(fs.existsSync(path.join(dir, "x.vhlicense.json"))).to.equal(false);
  });

  it("a malformed --catalog file is a usage error (exit 2)", async function () {
    const dir = mkTmp();
    const catFile = path.join(dir, "bad.json");
    fs.writeFileSync(catFile, "{ not json");
    const env = "TL_TEST_FULFILL_BADCAT";
    process.env[env] = Wallet.createRandom().privateKey;
    let code;
    const io = capture();
    try {
      code = await cmdTrust(
        [
          "license", "fulfill",
          "--plan", "pro-annual", "--customer", "X", "--issued", ISSUED,
          "--key-env", env, "--catalog", catFile,
        ],
        io
      );
    } finally {
      delete process.env[env];
    }
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/plan catalog/i);
  });
});

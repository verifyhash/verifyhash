"use strict";

// `vh evidence license fulfill` (T-48.2) — the EVIDENCE-vertical MIRROR of
// `vh trust license fulfill`.
//
// Proves the self-serve evidence fulfillment seam on top of the pure evidence plan
// catalog (T-48.1) and the existing signed-license core/gate:
//   * `vh evidence license fulfill` with an EPHEMERAL Wallet.createRandom() key writes
//     a signed `*.vhevidence-license.json` whose entitlements + window EXACTLY equal the
//     resolved plan's (entitlements come ONLY from the plan, never re-typed), and whose
//     bytes round-trip through the UNCHANGED evidence.readLicense / verifyLicense;
//   * the minted license UNLOCKS the paid `vh evidence seal --sign` surface end-to-end
//     (a real seal --sign run with --license/--vendor that would otherwise be gated);
//   * EXACTLY-ONE-of-key-source is enforced (neither/both hard-error key-free), and a
//     missing env var / malformed key / unknown plan / paidThrough<=issuedAt / malformed
//     --catalog each fail with a NAMED, KEY-FREE message and the documented exit code;
//   * exit 0 ok / 3 gate-fail / 2 usage / 1 IO mirrors the family;
//   * the loop NEVER holds a real key (every key is an ephemeral in-process Wallet) and
//     NEVER sets a price (the bundled catalog is a DRAFT skeleton);
//   * the existing seal/verify/verify-signed/diff exit codes + behavior are UNCHANGED
//     (a separate smoke check), and the unknown-subcommand reject now lists `license`.
//
// Every filesystem effect is isolated to a throwaway temp dir; the test asserts the
// working tree (cwd) is left UNTOUCHED, pass or fail.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Wallet } = require("ethers");

const evidence = require("../cli/evidence");
const evidencePlans = require("../cli/core/evidence-plans");

const { EXIT } = evidence;

const BUNDLED = evidence.BUNDLED_EVIDENCE_CATALOG;

// Pinned clocks so artifacts + verdicts are deterministic.
const ISSUED = "2026-06-01T00:00:00.000Z";
const IN_WINDOW = new Date("2026-06-10T00:00:00.000Z"); // within a 30-day term from ISSUED

// A FRESH validated catalog (the module is pure; the test does the I/O).
function catalog() {
  return evidencePlans.validateEvidencePlanCatalog(JSON.parse(fs.readFileSync(BUNDLED, "utf8")));
}

function capture(extra = {}) {
  const out = [];
  const err = [];
  return Object.assign(
    {
      write: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      // The fulfill default clock — pinned so the artifact is deterministic. issuedAt
      // is supplied explicitly via --issued in the helper below.
      nowISO: () => ISSUED,
      out: () => out.join(""),
      err: () => err.join(""),
    },
    extra
  );
}

describe("T-48.2: `vh evidence license fulfill` mints a license the evidence gate accepts", function () {
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
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ev-fulfill-"));
    tmpDirs.push(d);
    return d;
  }

  // Fulfill a license through the PUBLIC `vh evidence license fulfill`, reading the key
  // from an env var that holds an EPHEMERAL key for the duration of the call. Returns
  // { code, io, vendor, file, env } — the env var is DELETED after the call.
  async function fulfill(dir, { plan, customer, paidThrough, issued, extra = [], out = true } = {}) {
    const wallet = Wallet.createRandom();
    const env = "VH_EV_TEST_FULFILL_KEY";
    const file = path.join(dir, "customer.vhevidence-license.json");
    process.env[env] = wallet.privateKey;
    const io = capture();
    let code;
    try {
      const argv = [
        "license", "fulfill",
        "--plan", plan || "evidence-pro-annual",
        "--customer", customer || "Acme Co",
        "--issued", issued || ISSUED,
        "--key-env", env,
      ];
      if (out) argv.push("--out", file);
      if (paidThrough) argv.push("--paid-through", paidThrough);
      argv.push(...extra);
      code = await evidence.cmdEvidence(argv, io);
    } finally {
      delete process.env[env];
    }
    return { code, io, vendor: wallet.address, key: wallet.privateKey, file, env };
  }

  it("writes a *.vhevidence-license.json; entitlements + window EXACTLY equal the plan's; key NEVER echoed", async function () {
    const dir = mkTmp();
    const { code, io, vendor, key, file } = await fulfill(dir, { plan: "evidence-pro-annual" });
    expect(code).to.equal(EXIT.OK);

    // The written container parses + recovers to the ephemeral vendor.
    const container = evidence.readLicense(fs.readFileSync(file, "utf8"));
    const payload = JSON.parse(container.attestation);
    const plan = catalog().plansById["evidence-pro-annual"];
    // Entitlements come ONLY from the resolved plan — verbatim, never re-typed.
    expect(payload.entitlements).to.deep.equal(plan.entitlements);
    expect(payload.plan).to.equal("evidence-pro-annual");
    // Window EXACTLY the derived term (issuedAt + termDays days).
    const expectedExpiry = new Date(Date.parse(ISSUED) + plan.termDays * 86400000).toISOString();
    expect(payload.issuedAt).to.equal(ISSUED);
    expect(payload.expiresAt).to.equal(expectedExpiry);

    // The KEY is NEVER echoed (stdout or stderr) — only the PUBLIC vendor address.
    const all = io.out() + io.err();
    expect(all).to.not.include(key);
    expect(io.out().toLowerCase()).to.include(vendor.toLowerCase());
  });

  it("--json emits only PUBLIC fields (vendor address, summary); --paid-through WINS over the term", async function () {
    const dir = mkTmp();
    const paidThrough = "2026-12-31T00:00:00.000Z";
    const { code, io, vendor, key } = await fulfill(dir, {
      plan: "evidence-signed-monthly",
      paidThrough,
      out: false,
      extra: ["--json"],
    });
    expect(code).to.equal(EXIT.OK);
    const o = JSON.parse(io.out());
    expect(o.fulfilled).to.equal(true);
    expect(o.vendor.toLowerCase()).to.equal(vendor.toLowerCase());
    expect(o.expiresAt).to.equal(paidThrough); // paidThrough overrides the derived term
    expect(o.entitlements).to.deep.equal(["evidence_signed"]);
    // No --out: the canonical bytes ride in `container`; the KEY is never present.
    expect(typeof o.container).to.equal("string");
    expect(io.out()).to.not.include(key);
  });

  it("the minted license is ACCEPTED by the UNCHANGED evidence.verifyLicense (in-window, pinned vendor)", async function () {
    const dir = mkTmp();
    const { vendor, file } = await fulfill(dir, { plan: "evidence-pro-annual" });
    const container = evidence.readLicense(fs.readFileSync(file, "utf8"));
    const verdict = evidence.verifyLicense(container, { now: IN_WINDOW, vendorAddress: vendor });
    expect(verdict.valid).to.equal(true);
    expect(evidence.hasEntitlement(verdict, "evidence_signed")).to.equal(true);
    expect(evidence.hasEntitlement(verdict, "evidence_unlimited")).to.equal(true);
  });

  it("END-TO-END: the minted license UNLOCKS the paid `vh evidence seal --sign` surface", async function () {
    const dir = mkTmp();
    // evidence-signed-monthly grants evidence_signed (the entitlement --sign needs).
    const { vendor, file } = await fulfill(dir, { plan: "evidence-signed-monthly" });

    // A directory to seal + sign.
    const srcDir = path.join(dir, "src");
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, "a.txt"), "alpha");
    fs.writeFileSync(path.join(srcDir, "b.txt"), "bravo");

    // Sign with a FRESH ephemeral key (the operator's signing key is independent of the
    // vendor key that issued the license — the gate only checks the license, not who signs).
    const signWallet = Wallet.createRandom();
    const signEnv = "VH_EV_TEST_SIGN_KEY";
    process.env[signEnv] = signWallet.privateKey;
    const io = Object.assign(capture(), { now: IN_WINDOW });
    let code;
    try {
      code = await evidence.cmdEvidence(
        [
          "seal", srcDir,
          "--sign", "--key-env", signEnv,
          "--license", file, "--vendor", vendor,
          "--json",
        ],
        io
      );
    } finally {
      delete process.env[signEnv];
    }
    // The gate let the paid surface run (exit 0), proving the license unlocked --sign,
    // and a SIGNED packet was actually produced (the unlocked surface ran).
    expect(code).to.equal(EXIT.OK);
    const o = JSON.parse(io.out());
    expect(o.signed).to.equal(true);
    expect(o.kind).to.equal(evidence.SIGNED_SEAL_KIND);
  });

  it("a WITHOUT-evidence_signed license does NOT unlock --sign (gate refuses, exit 3)", async function () {
    const dir = mkTmp();
    // A custom catalog whose only plan grants evidence_unlimited (NOT evidence_signed).
    const customCat = {
      kind: "vh-evidence-plan-catalog",
      schemaVersion: 1,
      plans: [
        {
          planId: "unlimited-only",
          displayName: "Unlimited only — DRAFT",
          entitlements: ["evidence_unlimited"],
          termDays: 365,
        },
      ],
    };
    const catFile = path.join(dir, "catalog.json");
    fs.writeFileSync(catFile, JSON.stringify(customCat));
    const { code: fcode, vendor, file } = await fulfill(dir, {
      plan: "unlimited-only",
      extra: ["--catalog", catFile],
    });
    expect(fcode).to.equal(EXIT.OK);

    const srcDir = path.join(dir, "src");
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, "a.txt"), "alpha");
    const signWallet = Wallet.createRandom();
    const signEnv = "VH_EV_TEST_SIGN_KEY2";
    process.env[signEnv] = signWallet.privateKey;
    const io = Object.assign(capture(), { now: IN_WINDOW });
    let code;
    try {
      code = await evidence.cmdEvidence(
        ["seal", srcDir, "--sign", "--key-env", signEnv, "--license", file, "--vendor", vendor],
        io
      );
    } finally {
      delete process.env[signEnv];
    }
    // The plan lacks evidence_signed, so --sign is REFUSED (gate-fail, exit 3).
    expect(code).to.equal(EXIT.FAIL);
    expect(io.err()).to.match(/does NOT include the "evidence_signed"/);
  });

  it("an explicit --catalog resolves a plan; --license-id WINS over the deterministic default", async function () {
    const dir = mkTmp();
    const { io, code } = await fulfill(dir, {
      plan: "evidence-signed-monthly",
      out: false,
      extra: ["--license-id", "ORDER-77", "--json"],
    });
    expect(code).to.equal(EXIT.OK);
    expect(JSON.parse(io.out()).licenseId).to.equal("ORDER-77");
  });
});

// ===========================================================================
// key-source discipline + catalog/order errors (KEY-FREE messages, exit codes).
// ===========================================================================

describe("T-48.2: `evidence license fulfill` key-source + order errors are key-free", function () {
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
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ev-fulfill-err-"));
    tmpDirs.push(d);
    return d;
  }

  it("NEITHER key source hard-errors (exit 2) with an actionable, key-free message", async function () {
    const io = capture();
    const code = await evidence.cmdEvidence(
      ["license", "fulfill", "--plan", "evidence-pro-annual", "--customer", "X", "--issued", ISSUED],
      io
    );
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/key/i);
    expect(io.err()).to.not.match(/0x[0-9a-fA-F]{40,}/); // no key-shaped long hex leaked
  });

  it("BOTH key sources hard-error (exit 2), key-free", async function () {
    const dir = mkTmp();
    const keyFile = path.join(dir, "k.key");
    const w = Wallet.createRandom();
    fs.writeFileSync(keyFile, w.privateKey);
    const env = "VH_EV_TEST_FULFILL_BOTH";
    process.env[env] = w.privateKey;
    let code;
    const io = capture();
    try {
      code = await evidence.cmdEvidence(
        [
          "license", "fulfill",
          "--plan", "evidence-pro-annual", "--customer", "X", "--issued", ISSUED,
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
    const env = "VH_EV_TEST_FULFILL_MISSING";
    delete process.env[env];
    const io = capture();
    const code = await evidence.cmdEvidence(
      [
        "license", "fulfill",
        "--plan", "evidence-pro-annual", "--customer", "X", "--issued", ISSUED,
        "--key-env", env,
      ],
      io
    );
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.include(env);
  });

  it("a MALFORMED key hard-errors (exit 2) with a fixed key-free message", async function () {
    const env = "VH_EV_TEST_FULFILL_BADKEY";
    process.env[env] = "not-a-real-private-key";
    let code;
    const io = capture();
    try {
      code = await evidence.cmdEvidence(
        [
          "license", "fulfill",
          "--plan", "evidence-pro-annual", "--customer", "X", "--issued", ISSUED,
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

  it("--plan / --customer are REQUIRED (exit 2)", async function () {
    const io1 = capture();
    expect(
      await evidence.cmdEvidence(["license", "fulfill", "--customer", "X"], io1)
    ).to.equal(EXIT.USAGE);
    expect(io1.err()).to.match(/--plan/);
    const io2 = capture();
    expect(
      await evidence.cmdEvidence(["license", "fulfill", "--plan", "evidence-pro-annual"], io2)
    ).to.equal(EXIT.USAGE);
    expect(io2.err()).to.match(/--customer/);
  });

  it("an UNKNOWN plan is a usage error (exit 2); key never read into output; NO file written", async function () {
    const dir = mkTmp();
    const env = "VH_EV_TEST_FULFILL_UNKNOWNPLAN";
    const w = Wallet.createRandom();
    process.env[env] = w.privateKey;
    const outFile = path.join(dir, "x.vhevidence-license.json");
    let code;
    const io = capture();
    try {
      code = await evidence.cmdEvidence(
        [
          "license", "fulfill",
          "--plan", "no-such-plan", "--customer", "X", "--issued", ISSUED,
          "--key-env", env, "--out", outFile,
        ],
        io
      );
    } finally {
      delete process.env[env];
    }
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/unknown plan/i);
    expect(io.err() + io.out()).to.not.include(w.privateKey);
    expect(fs.existsSync(outFile)).to.equal(false);
  });

  it("paidThrough <= issuedAt is a usage error (exit 2), key-free", async function () {
    const env = "VH_EV_TEST_FULFILL_BADWINDOW";
    const w = Wallet.createRandom();
    process.env[env] = w.privateKey;
    let code;
    const io = capture();
    try {
      code = await evidence.cmdEvidence(
        [
          "license", "fulfill",
          "--plan", "evidence-pro-annual", "--customer", "X", "--issued", ISSUED,
          "--paid-through", ISSUED, // equal to issuedAt => empty window
          "--key-env", env,
        ],
        io
      );
    } finally {
      delete process.env[env];
    }
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/strictly AFTER issuedAt/i);
    expect(io.err()).to.not.include(w.privateKey);
  });

  it("a malformed --catalog file is a usage error (exit 2)", async function () {
    const dir = mkTmp();
    const catFile = path.join(dir, "bad.json");
    fs.writeFileSync(catFile, "{ not json");
    const env = "VH_EV_TEST_FULFILL_BADCAT";
    process.env[env] = Wallet.createRandom().privateKey;
    let code;
    const io = capture();
    try {
      code = await evidence.cmdEvidence(
        [
          "license", "fulfill",
          "--plan", "evidence-pro-annual", "--customer", "X", "--issued", ISSUED,
          "--key-env", env, "--catalog", catFile,
        ],
        io
      );
    } finally {
      delete process.env[env];
    }
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/evidence plan catalog/i);
  });

  it("an unknown `license` subcommand is a usage error (exit 2), naming `fulfill`", async function () {
    const io = capture();
    const code = await evidence.cmdEvidence(["license", "bogus"], io);
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/unknown evidence license subcommand.*fulfill/i);
  });

  it("an unknown evidence subcommand reject now lists `license`", async function () {
    const io = capture();
    const code = await evidence.cmdEvidence(["nope"], io);
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/expected: seal, verify, verify-signed, diff, license/);
  });
});

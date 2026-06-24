"use strict";

// TrustLedger — `vh trust license issue|verify` + the reconcile LICENSE GATE (T-29.2).
//
// Proves the CLI seam on top of the pure license core (T-29.1):
//   * `license issue` reads a HUMAN-supplied key (EXACTLY ONE of --key-env/--key-file,
//     reused-then-discarded), signs a license, and prints ONLY the PUBLIC vendor
//     address + summary + path — the KEY is NEVER written/echoed/logged;
//   * `license verify <file> --vendor <0xaddr>` is read-only, OFFLINE, key-free:
//     VALID -> exit 0; a WRONG --vendor -> INVALID/wrong_issuer -> exit 3;
//   * the reconcile GATE: `--state`/`--seal` WITHOUT a license hard-error (exit 2)
//     naming the license requirement; the SAME run WITH a valid license produces the
//     sealed, state-policied packet; an EXPIRED license refuses the gated feature;
//   * the FREE baseline reconcile + `vh trust inspect` run with NO license at all.
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
const licenseMod = require("../trustledger/license");

const FIX = path.join(__dirname, "..", "trustledger", "fixtures", "e2e");
const BANK = path.join(FIX, "bank.csv");
const BOOK = path.join(FIX, "quickbooks.csv");
const RENT = path.join(FIX, "rentroll.csv");

const DATE = "2026-06-24"; // pinned report date / verify clock

function capture(extra = {}) {
  const out = [];
  const err = [];
  return Object.assign(
    {
      write: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      today: () => DATE,
      // The issuer/verify default clock — pinned so the artifact + verdict are deterministic.
      nowISO: () => `${DATE}T12:00:00.000Z`,
      out: () => out.join(""),
      err: () => err.join(""),
    },
    extra
  );
}

describe("trustledger T-29.2: `vh trust license` + the reconcile license gate", function () {
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
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "tl-lic-cli-"));
    tmpDirs.push(d);
    return d;
  }

  // Mint a license through the PUBLIC `vh trust license issue` command, reading the
  // key from an env var that holds an EPHEMERAL key for the duration of the call.
  // Returns { code, io, vendor, file, env } — the env var is DELETED after the call.
  async function issueLicense(dir, { entitlements, expires, issued, extra = [] } = {}) {
    const wallet = Wallet.createRandom();
    const env = "TL_TEST_LICENSE_KEY";
    const file = path.join(dir, "customer.vhlicense.json");
    process.env[env] = wallet.privateKey;
    let code;
    const io = capture();
    try {
      code = await cmdTrust(
        [
          "license", "issue",
          "--customer", "Acme Realty LLC",
          "--plan", "pro-annual",
          "--entitlements", entitlements || "multi_state_policy,seal",
          "--expires", expires || "2027-01-01T00:00:00.000Z",
          // Default issuedAt is pinned EARLIER than the run/verify clock so the
          // license is in-window whether `now` is DATE-midnight (the reconcile gate)
          // or DATE-noon (the verify default) — robust to both.
          "--issued", issued || "2026-01-01T00:00:00.000Z",
          "--key-env", env,
          "--out", file,
          ...extra,
        ],
        io
      );
    } finally {
      delete process.env[env];
    }
    return { code, io, vendor: wallet.address, walletKey: wallet.privateKey, file, env };
  }

  // ---------------------------------------------------------------- issue
  it("issue -> verify round-trips VALID and prints ONLY the public vendor address (key never echoed)", async function () {
    const dir = mkTmp();
    const { code, io, vendor, file, walletKey } = await issueLicense(dir);
    expect(code).to.equal(EXIT.PASS);

    // The success output names the PUBLIC vendor address + the summary + the path.
    expect(io.out()).to.contain(vendor.toLowerCase());
    expect(io.out()).to.contain("Acme Realty LLC");
    expect(io.out()).to.contain("multi_state_policy");
    expect(io.out()).to.contain(file);
    // The KEY is NEVER present in stdout OR stderr (no leak on success).
    expect(io.out()).to.not.contain(walletKey);
    expect(io.err()).to.not.contain(walletKey);
    expect(io.out()).to.not.contain(walletKey.slice(2)); // not even the bare hex

    // The license file is a sound signed container that verifies VALID against the vendor.
    const container = licenseMod.readLicense(fs.readFileSync(file, "utf8"));
    expect(container.kind).to.equal("trustledger-license-signed");

    const vio = capture();
    const vcode = cmdTrust(
      ["license", "verify", file, "--vendor", vendor, "--now", `${DATE}T12:00:00.000Z`],
      vio
    );
    expect(vcode).to.equal(EXIT.PASS);
    expect(vio.out()).to.contain("VALID");
    expect(vio.out()).to.contain("multi_state_policy");
    expect(vio.out()).to.contain("seal");
    expect(vio.out()).to.contain("2027-01-01T00:00:00.000Z");
  });

  it("verify against the WRONG --vendor is INVALID/wrong_issuer with exit 3", async function () {
    const dir = mkTmp();
    const { file } = await issueLicense(dir);
    const wrong = Wallet.createRandom().address; // not the issuer

    const io = capture();
    const code = cmdTrust(
      ["license", "verify", file, "--vendor", wrong, "--now", `${DATE}T12:00:00.000Z`],
      io
    );
    expect(code).to.equal(EXIT.FAIL); // exit 3 = invalid
    expect(io.out()).to.contain("INVALID");
    expect(io.out()).to.contain("wrong_issuer");

    // --json carries the same precise reason verifyLicense returns.
    const jio = capture();
    expect(
      cmdTrust(["license", "verify", file, "--vendor", wrong, "--now", `${DATE}T12:00:00.000Z`, "--json"], jio)
    ).to.equal(EXIT.FAIL);
    const j = JSON.parse(jio.out());
    expect(j.valid).to.equal(false);
    expect(j.reason).to.equal("wrong_issuer");
  });

  it("issue HARD-ERRORS without a key, with both key sources, and on a malformed flag — never leaking the key", async function () {
    const dir = mkTmp();
    const file = path.join(dir, "x.vhlicense.json");

    // Neither key source.
    const io1 = capture();
    expect(
      await cmdTrust(
        ["license", "issue", "--customer", "C", "--plan", "p", "--entitlements", "seal", "--expires", "2027-01-01T00:00:00.000Z", "--out", file],
        io1
      )
    ).to.equal(EXIT.USAGE);
    expect(io1.err()).to.match(/no signing key|EXACTLY ONE/);

    // Both key sources -> mutually exclusive.
    const key = Wallet.createRandom().privateKey;
    const env = "TL_TEST_BOTH_KEY";
    const kf = path.join(dir, "key.txt");
    fs.writeFileSync(kf, key);
    process.env[env] = key;
    const io2 = capture();
    try {
      expect(
        await cmdTrust(
          ["license", "issue", "--customer", "C", "--plan", "p", "--entitlements", "seal", "--expires", "2027-01-01T00:00:00.000Z", "--key-env", env, "--key-file", kf, "--out", file],
          io2
        )
      ).to.equal(EXIT.USAGE);
    } finally {
      delete process.env[env];
    }
    expect(io2.err()).to.match(/mutually exclusive/);
    expect(io2.err()).to.not.contain(key);

    // A malformed entitlement is a usage error (the license core rejects it), key-free.
    const env3 = "TL_TEST_BAD_ENT";
    process.env[env3] = key;
    const io3 = capture();
    try {
      expect(
        await cmdTrust(
          ["license", "issue", "--customer", "C", "--plan", "p", "--entitlements", "teleportation", "--expires", "2027-01-01T00:00:00.000Z", "--key-env", env3, "--out", file],
          io3
        )
      ).to.equal(EXIT.USAGE);
    } finally {
      delete process.env[env3];
    }
    expect(io3.err()).to.match(/unknown license entitlement/);
    expect(io3.err()).to.not.contain(key);
  });

  it("verify hard-errors on a malformed --vendor WITHOUT leaking anything, and requires --vendor", async function () {
    const dir = mkTmp();
    const { file } = await issueLicense(dir);

    const io = capture();
    expect(cmdTrust(["license", "verify", file, "--vendor", "not-an-address"], io)).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/valid vendorAddress/);

    const io2 = capture();
    expect(cmdTrust(["license", "verify", file], io2)).to.equal(EXIT.USAGE);
    expect(io2.err()).to.match(/requires --vendor/);
  });

  // ----------------------------------------------------------------- gate
  it("GATE: `reconcile --state CA --seal` WITHOUT a license hard-errors (exit 2) naming the license requirement", function () {
    const dir = mkTmp();
    const io = capture();
    const code = cmdTrust(
      ["reconcile", BANK, BOOK, RENT, "--date", DATE, "--out", dir, "--state", "ca-example", "--seal"],
      io
    );
    expect(code).to.equal(EXIT.USAGE); // exit 2 = a clear gate, not a crash
    expect(io.err()).to.match(/requires a license/);
    expect(io.err()).to.match(/vh trust license/);
    expect(io.err()).to.match(/--license <file> --vendor <0xaddr>/);
    // The gate fires BEFORE any packet is built: nothing written to --out.
    expect(fs.readdirSync(dir)).to.deep.equal([]);
  });

  it("GATE: the SAME run WITH a valid license produces the sealed, state-policied packet", async function () {
    const dir = mkTmp(); // packet dir
    const licDir = mkTmp(); // license lives elsewhere (keeps the packet dir clean)
    const { code: icode, vendor, file } = await issueLicense(licDir);
    expect(icode).to.equal(EXIT.PASS);

    const io = capture();
    const code = cmdTrust(
      [
        "reconcile", BANK, BOOK, RENT,
        "--date", DATE, "--out", dir,
        "--state", "ca-example", "--seal",
        "--license", file, "--vendor", vendor,
      ],
      io
    );
    // The fixtures tie out, so the state-policied run is a PASS; the seal is written.
    expect(code).to.equal(EXIT.PASS);
    const sealName = `reconciliation-${DATE}-seal.json`;
    expect(fs.existsSync(path.join(dir, sealName)), "seal written").to.equal(true);
    expect(io.out()).to.contain(`wrote seal ${path.join(dir, sealName)}`);

    // The packet was scored under the per-state policy (proves the multi_state_policy
    // unlock actually engaged, not a silent free downgrade).
    const jio = capture();
    const jcode = cmdTrust(
      [
        "reconcile", BANK, BOOK, RENT,
        "--date", DATE, "--out", mkTmp(),
        "--state", "ca-example", "--json",
        "--license", file, "--vendor", vendor,
      ],
      jio
    );
    expect(jcode).to.equal(EXIT.PASS);
    const parsed = JSON.parse(jio.out());
    expect(parsed.policy).to.not.equal(null);
    expect(parsed.policy.state).to.match(/EXAMPLE-STATE/);
  });

  it("GATE: an EXPIRED license refuses the gated feature with the precise reason (never a silent free downgrade)", async function () {
    const dir = mkTmp();
    const licDir = mkTmp();
    // Issue a license whose window ended in the past relative to the run's DATE.
    const { code: icode, vendor, file } = await issueLicense(licDir, {
      issued: "2020-01-01T00:00:00.000Z",
      expires: "2021-01-01T00:00:00.000Z",
    });
    expect(icode).to.equal(EXIT.PASS);

    const io = capture();
    const code = cmdTrust(
      [
        "reconcile", BANK, BOOK, RENT,
        "--date", DATE, "--out", dir,
        "--seal",
        "--license", file, "--vendor", vendor,
      ],
      io
    );
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/INVALID \(reason: expired\)/);
    // Refused: no seal/packet written despite valid signature (it expired).
    expect(fs.readdirSync(dir)).to.deep.equal([]);
  });

  it("GATE: a license missing the needed entitlement is refused even though it is VALID", async function () {
    const dir = mkTmp();
    const licDir = mkTmp();
    // A license that grants ONLY multi_state_policy, used to try to unlock --seal.
    const { vendor, file } = await issueLicense(licDir, { entitlements: "multi_state_policy" });

    const io = capture();
    const code = cmdTrust(
      [
        "reconcile", BANK, BOOK, RENT,
        "--date", DATE, "--out", dir,
        "--seal",
        "--license", file, "--vendor", vendor,
      ],
      io
    );
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/does NOT include the "seal" entitlement/);
    expect(fs.readdirSync(dir)).to.deep.equal([]);
  });

  it("GATE: --license without --vendor (and vice-versa) is a usage error", async function () {
    const dir = mkTmp();
    const licDir = mkTmp();
    const { vendor, file } = await issueLicense(licDir);

    const io1 = capture();
    expect(
      cmdTrust(["reconcile", BANK, BOOK, RENT, "--date", DATE, "--out", dir, "--seal", "--license", file], io1)
    ).to.equal(EXIT.USAGE);
    expect(io1.err()).to.match(/must be supplied together/);

    const io2 = capture();
    expect(
      cmdTrust(["reconcile", BANK, BOOK, RENT, "--date", DATE, "--out", dir, "--seal", "--vendor", vendor], io2)
    ).to.equal(EXIT.USAGE);
    expect(io2.err()).to.match(/must be supplied together/);
  });

  // -------------------------------------------------------------- free tier
  it("FREE TIER: the baseline reconcile runs with NO license at all (byte-for-byte, exit 0)", function () {
    const dir = mkTmp();
    const io = capture();
    const code = cmdTrust(["reconcile", BANK, BOOK, RENT, "--date", DATE, "--out", dir], io);
    expect(code).to.equal(EXIT.PASS);
    // Exactly the three dated packet files — no seal, no license artifact.
    expect(fs.readdirSync(dir).sort()).to.deep.equal([
      `reconciliation-${DATE}-balances.csv`,
      `reconciliation-${DATE}-exceptions.csv`,
      `reconciliation-${DATE}.html`,
    ]);
    expect(io.out()).to.match(/^PASS:/m);
  });

  it("FREE TIER: `vh trust inspect` runs with NO license at all", function () {
    const io = capture();
    const code = cmdTrust(["inspect", BANK, "--as", "bank"], io);
    expect(code).to.equal(EXIT.PASS);
    // It is read-only (writes nothing) and needs no license.
    expect(io.out().length).to.be.greaterThan(0);
  });
});

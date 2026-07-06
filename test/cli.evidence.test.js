"use strict";

// `vh evidence seal|verify` (T-30.3) — the product-agnostic, license-gated, tamper-evident evidence
// packet, built ENTIRELY on the extracted shared cores (cli/core/packetseal.js + cli/core/license.js).
//
// What these prove (the acceptance criteria):
//   * seal --out then verify ACCEPTS a genuine packet (root re-derives from the bytes on disk);
//   * editing a file in the dir makes verify report EXACTLY that file CHANGED with a non-zero exit;
//   * a packet stores a GENERIC product kind (`vh.evidence-seal`) — no trust-reconcile vocabulary;
//   * the PAID surface (the signed wrap; sealing > the free sample) 4xx/exit-REJECTS WITHOUT a valid
//     license and SUCCEEDS WITH a license minted by the run's CANONICAL vendor key (declared for these
//     ephemeral-key tests via the programmatic io.canonicalVendor seam — never argv; T-75.3);
//   * a license signed by a NON-canonical key is wrong_issuer (the gate refuses, never downgrades);
//   * --json round-trips (seal --json artifact verifies; verify --json carries the structured verdict);
//   * the output LEADS with the TRUST-BOUNDARIES one-liner;
//   * every write lands under a throwaway temp dir; the working tree (cwd) is left CLEAN.
//
// Every signing key is an EPHEMERAL in-process Wallet.createRandom() (TEST-ONLY, never a real key/real
// funds). The license window is dated with an injected `now` so verdicts are deterministic.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Wallet } = require("ethers");

const evidence = require("../cli/evidence");

const NOW = new Date("2026-06-24T12:00:00.000Z");
const ISSUED = "2026-06-01T00:00:00.000Z";
const EXPIRES = "2027-06-01T00:00:00.000Z";

function capture(extra = {}) {
  const out = [];
  const err = [];
  return Object.assign(
    {
      write: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      now: NOW,
      out: () => out.join(""),
      err: () => err.join(""),
    },
    extra
  );
}

// Mint an ephemeral-key evidence license carrying `entitlements`, write it to `dir`, return
// { file, vendor }. The vendor is the wallet's PUBLIC address (what the gate pins against).
async function mintLicense(dir, entitlements, wallet) {
  const w = wallet || Wallet.createRandom();
  const container = await evidence.buildLicense(
    {
      licenseId: "EV-TEST-1",
      customer: "ACME Evidence Co",
      plan: "pro",
      entitlements,
      issuedAt: ISSUED,
      expiresAt: EXPIRES,
    },
    w
  );
  // The container is an already-validated plain object; write it as JSON. The gate's readLicense
  // re-validates it on the read side (strict, wrap-don't-edit), so a plain JSON.stringify is faithful.
  const file = path.join(dir, "evidence.vhlicense.json");
  fs.writeFileSync(file, JSON.stringify(container) + "\n");
  return { file, vendor: w.address };
}

describe("cli/evidence T-30.3: `vh evidence seal|verify`", function () {
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
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-evidence-"));
    tmpDirs.push(d);
    return d;
  }
  // Build a sealable directory with a few small files. Returns the dir abs path.
  function mkDir(n = 3) {
    const root = mkTmp();
    const d = path.join(root, "payload");
    fs.mkdirSync(d);
    for (let i = 0; i < n; i++) {
      fs.writeFileSync(path.join(d, `f${i}.txt`), `content-${i}\n`);
    }
    return d;
  }

  it("seal --out then verify ACCEPTS a genuine packet, leads with the trust note", async function () {
    const dir = mkDir(3);
    const out = path.join(path.dirname(dir), "packet.vhevidence.json");
    const io = capture();

    const sealCode = await evidence.runEvidenceSeal({ dir, out }, io);
    expect(sealCode).to.equal(evidence.EXIT.OK);
    // Output LEADS with the TRUST-BOUNDARIES one-liner.
    expect(io.out()).to.match(/^This evidence seal is TAMPER-EVIDENT \+ OFFLINE-RECOMPUTABLE, NOT a trusted timestamp/);
    expect(fs.existsSync(out)).to.equal(true);

    // The packet carries a GENERIC product kind — no trust-reconcile vocabulary.
    const packet = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(packet.kind).to.equal("vh.evidence-seal");
    expect(JSON.stringify(packet)).to.not.match(/reconcile|verdict|rentroll|role|period/i);

    // verify --dir <the sealed dir> ACCEPTS.
    const vio = capture();
    const vcode = evidence.runEvidenceVerify({ packet: out, dir }, vio);
    expect(vcode).to.equal(evidence.EXIT.OK);
    expect(vio.out()).to.match(/OK — every sealed file re-derives byte-for-byte/);
  });

  it("editing a file makes verify report EXACTLY that file CHANGED, non-zero exit", async function () {
    const dir = mkDir(3);
    const out = path.join(path.dirname(dir), "packet.vhevidence.json");
    await evidence.runEvidenceSeal({ dir, out }, capture());

    // Tamper with ONE file.
    fs.writeFileSync(path.join(dir, "f1.txt"), "TAMPERED\n");

    const vio = capture({ json: undefined });
    const vcode = evidence.runEvidenceVerify({ packet: out, dir, json: true }, vio);
    expect(vcode).to.equal(evidence.EXIT.FAIL);
    const v = JSON.parse(vio.out());
    expect(v.verdict).to.equal("REJECTED");
    expect(v.changed.map((c) => c.relPath)).to.deep.equal(["f1.txt"]);
    expect(v.counts.changed).to.equal(1);
    expect(v.counts.missing).to.equal(0);
    expect(v.counts.unexpected).to.equal(0);
    expect(v.rootMatches).to.equal(false);
  });

  it("FREE tier: an unsigned baseline seal of a small dir needs NO license", async function () {
    const dir = mkDir(2);
    const io = capture();
    const code = await evidence.runEvidenceSeal({ dir }, io); // no --out: prints, writes nothing
    expect(code).to.equal(evidence.EXIT.OK);
    // Default (no --out): the seal bytes print to stdout, nothing is written.
    expect(io.out()).to.include('"kind":"vh.evidence-seal"');
  });

  it("PAID --sign REJECTS without a license (usage exit), with a key-free message", async function () {
    const dir = mkDir(2);
    const io = capture();
    // Provide a key source so the gate (not the wallet) is what rejects.
    const code = await evidence.runEvidenceSeal({ dir, sign: true, keyEnv: "EV_TEST_KEY" }, io);
    expect(code).to.equal(evidence.EXIT.USAGE);
    expect(io.err()).to.match(/PAID surface and requires a license/);
    expect(io.err()).to.not.match(/0x[0-9a-fA-F]{40,}/); // never echoes a key
  });

  it("PAID --sign SUCCEEDS with a valid license minted by the CANONICAL vendor key", async function () {
    const dir = mkDir(2);
    const lroot = mkTmp();
    const wallet = Wallet.createRandom();
    const { file: licFile, vendor } = await mintLicense(lroot, ["evidence_signed"], wallet);
    const out = path.join(lroot, "signed.vhevidence.json");

    // Sign with a SEPARATE ephemeral operator key (read from env, used, discarded). The gate pins the
    // license to the CANONICAL vendor identity (T-75.3); this test IS its own instance, so it declares
    // the ephemeral vendor canonical via the programmatic `io.canonicalVendor` seam (never argv). The
    // matching --vendor assertion is also passed — it must be ACCEPTED (it EQUALS the canonical).
    const opWallet = Wallet.createRandom();
    const prev = process.env.EV_OP_KEY;
    process.env.EV_OP_KEY = opWallet.privateKey;
    try {
      const io = capture({ canonicalVendor: vendor });
      const code = await evidence.runEvidenceSeal(
        { dir, out, sign: true, keyEnv: "EV_OP_KEY", license: licFile, vendor },
        io
      );
      expect(code).to.equal(evidence.EXIT.OK);
      expect(io.out()).to.match(/signed by:\s+0x[0-9a-f]{40}/);
    } finally {
      if (prev === undefined) delete process.env.EV_OP_KEY;
      else process.env.EV_OP_KEY = prev;
    }

    // The signed packet is a signed-seal container that still verifies offline.
    const container = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(container.kind).to.equal("vh.evidence-seal-signed");
    expect(container.signature.signer.toLowerCase()).to.equal(opWallet.address.toLowerCase());

    const vio = capture();
    const vcode = evidence.runEvidenceVerify({ packet: out, dir, json: true }, vio);
    expect(vcode).to.equal(evidence.EXIT.OK);
    const v = JSON.parse(vio.out());
    expect(v.signed).to.equal(true);
    expect(v.verdict).to.equal("ACCEPTED");
  });

  it("a license signed by a NON-canonical key is wrong_issuer (gate refuses, never downgrades)", async function () {
    const dir = mkDir(2);
    const lroot = mkTmp();
    // Mint with key A; the gate's CANONICAL identity for this run is a DIFFERENT address B (T-75.3 —
    // the pin is the canonical identity, never whatever key signed the file).
    const { file: licFile } = await mintLicense(lroot, ["evidence_signed"], Wallet.createRandom());
    const wrongCanonical = Wallet.createRandom().address;
    const out = path.join(lroot, "nope.vhevidence.json");

    const opWallet = Wallet.createRandom();
    const prev = process.env.EV_OP_KEY;
    process.env.EV_OP_KEY = opWallet.privateKey;
    try {
      const io = capture({ canonicalVendor: wrongCanonical });
      const code = await evidence.runEvidenceSeal(
        { dir, out, sign: true, keyEnv: "EV_OP_KEY", license: licFile },
        io
      );
      expect(code).to.equal(evidence.EXIT.FAIL);
      expect(io.err()).to.match(/requires a VALID license, but the supplied license is wrong_issuer/);
      // The named refusal explains the self-mint defense + the honest self-hosting story.
      expect(io.err()).to.match(/minted by the canonical vendor key/);
      expect(fs.existsSync(out)).to.equal(false); // nothing written on a refused gate
    } finally {
      if (prev === undefined) delete process.env.EV_OP_KEY;
      else process.env.EV_OP_KEY = prev;
    }
  });

  it("PAID over-sample (> free SAMPLE_LIMIT files) needs the evidence_unlimited entitlement", async function () {
    const n = evidence.SAMPLE_LIMIT + 5;
    const dir = mkDir(n);
    const lroot = mkTmp();
    const out = path.join(lroot, "big.vhevidence.json");

    // (a) WITHOUT a license -> usage reject naming the sample limit.
    const io1 = capture();
    const code1 = await evidence.runEvidenceSeal({ dir, out }, io1);
    expect(code1).to.equal(evidence.EXIT.USAGE);
    expect(io1.err()).to.match(/more than the free sample size/);
    expect(fs.existsSync(out)).to.equal(false);

    // (b) WITH a valid canonical-vendor license carrying evidence_unlimited -> succeeds.
    const wallet = Wallet.createRandom();
    const { file: licFile, vendor } = await mintLicense(lroot, ["evidence_unlimited"], wallet);
    const io2 = capture({ canonicalVendor: vendor });
    const code2 = await evidence.runEvidenceSeal({ dir, out, license: licFile, vendor }, io2);
    expect(code2).to.equal(evidence.EXIT.OK);
    const packet = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(packet.fileCount).to.equal(n);

    // (c) A valid license WITHOUT the needed entitlement is refused (valid but under-entitled).
    const { file: wrongLic, vendor: v2 } = await mintLicense(lroot, ["evidence_signed"], Wallet.createRandom());
    const io3 = capture({ canonicalVendor: v2 });
    const out3 = path.join(lroot, "big3.vhevidence.json");
    const code3 = await evidence.runEvidenceSeal({ dir, out: out3, license: wrongLic, vendor: v2 }, io3);
    expect(code3).to.equal(evidence.EXIT.FAIL);
    expect(io3.err()).to.match(/does NOT include the "evidence_unlimited" entitlement/);
  });

  it("--json seal artifact (no --out) round-trips through verify", async function () {
    const dir = mkDir(3);
    const io = capture();
    const code = await evidence.runEvidenceSeal({ dir, json: true }, io);
    expect(code).to.equal(evidence.EXIT.OK);
    const res = JSON.parse(io.out());
    expect(res.ok).to.equal(true);
    expect(res.out).to.equal(null);
    expect(res.artifact).to.be.a("string");

    // Persist the artifact NEXT TO the dir and verify it.
    const out = path.join(path.dirname(dir), "from-json.vhevidence.json");
    fs.writeFileSync(out, res.artifact);
    const vio = capture();
    const vcode = evidence.runEvidenceVerify({ packet: out, dir, json: true }, vio);
    expect(vcode).to.equal(evidence.EXIT.OK);
    expect(JSON.parse(vio.out()).verdict).to.equal("ACCEPTED");
  });

  it("parser parity: unknown/incomplete flags hard-error with usage (exit 2)", async function () {
    const dir = mkDir(1);
    const io1 = capture();
    expect(await evidence.cmdEvidence(["seal", dir, "--bogus"], io1)).to.equal(evidence.EXIT.USAGE);
    expect(io1.err()).to.match(/unknown flag: --bogus/);

    const io2 = capture();
    expect(await evidence.cmdEvidence(["seal", dir, "--out"], io2)).to.equal(evidence.EXIT.USAGE);
    expect(io2.err()).to.match(/--out requires a value/);

    const io3 = capture();
    expect(await evidence.cmdEvidence(["verify", "a", "b"], io3)).to.equal(evidence.EXIT.USAGE);
    expect(io3.err()).to.match(/takes exactly one <packet>/);

    const io4 = capture();
    expect(await evidence.cmdEvidence(["frobnicate"], io4)).to.equal(evidence.EXIT.USAGE);
    expect(io4.err()).to.match(/unknown evidence subcommand/);
  });

  it("seal of a missing dir is IO (1); verify of a missing packet is IO (1)", async function () {
    const io1 = capture();
    expect(await evidence.runEvidenceSeal({ dir: "/no/such/dir/here" }, io1)).to.equal(evidence.EXIT.IO);
    const io2 = capture();
    expect(evidence.runEvidenceVerify({ packet: "/no/such/packet.json" }, io2)).to.equal(evidence.EXIT.IO);
  });
});

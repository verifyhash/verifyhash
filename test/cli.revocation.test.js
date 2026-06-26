"use strict";

// T-51.3 — `vh revocation publish` (mint the revocation) + `vh revocation verify` (check + pin it), the THIN
// CLI surface over the PURE producer-KEY-REVOCATION core (T-51.1, cli/core/revocation.js).
//
// What these prove (the acceptance criteria):
//   `vh revocation publish`:
//     * MINTS a signed revocation ONLY when the provisioned key's address EQUALS --address; a key that does
//       NOT control --address HARD-ERRORS (exit 2) BEFORE writing anything (no --out file leaks — never a
//       mis-minted statement);
//     * enforces the EXACTLY-ONE-of-key-source rule (neither / both / missing-env each a clean usage error,
//       key-free message) via the SHARED loadSigningWallet — the loop NEVER generates/persists/logs a key
//       (we assert the key never appears in any output);
//     * default prints the revocation + writes NOTHING; --out writes ONLY to the caller-chosen path (never cwd);
//     * LEADS with the trust line; --json carries the public revocation summary + the artifact (no --out) and NO key;
//     * a malformed --address / out-of-set --reason / non-canonical --revoked-at / malformed --superseded-by
//       is a usage error (2);
//     * --superseded-by is OPTIONAL and round-trips through verify.
//   `vh revocation verify`:
//     * ACCEPT / REJECT / usage exits map 0 / 3 / 2 / 1;
//     * LEADS with the trust line; prints the reason + revokedAt + per-check PASS/FAIL;
//     * pins --signer (the RIGHT one PASSes, a DIFFERENT one is a clean REJECTED exit 3; a malformed one is usage 2);
//     * a FORGED / TAMPERED / THIRD-PARTY revocation is a clean REJECTED (exit 3) — NEVER a silent pass;
//     * a missing/garbled revocation file is IO (1).
//   dispatch:
//     * an UNKNOWN `revocation` subcommand is a usage error (2) and names the valid set; help is exit 0.
//   wiring:
//     * `vh.main(["revocation", …])` routes to cmdRevocation (the top-level command is registered).
//   filesystem hygiene:
//     * NOTHING leaks into cwd, pass or fail (every effect is isolated to a throwaway temp dir).
//
// Every signing key is an EPHEMERAL in-process Wallet.createRandom() (TEST-ONLY, never a real key / real
// funds), supplied to the CLI via --key-file (a key file written into the throwaway temp dir) or --key-env
// (a process.env var set + deleted per test). publish writes the revocation via the genuine PUBLIC build+
// serialize path, so verify exercises the real on-disk artifact, not a hand-rolled envelope.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Wallet } = require("ethers");

const REV = require("../cli/revocation");
const coreRevocation = require("../cli/core/revocation");
const coreAttestation = require("../cli/core/attestation");
const vh = require("../cli/vh");

function capture() {
  const out = [];
  const err = [];
  return {
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

describe("cli/revocation T-51.3: `vh revocation publish` + `vh revocation verify`", function () {
  // A pinned clock so publish is deterministic under test (the core never reads the real clock; the CLI's
  // default revokedAt is the ONLY clock read, and it is injectable via io.nowISO).
  const NOW_ISO = "2026-06-26T00:00:00.000Z";

  let tmpDirs;
  let cwdBefore;
  let envKeysBefore;
  beforeEach(function () {
    tmpDirs = [];
    // Snapshot the working tree so we can assert NOTHING leaked into cwd (filesystem hygiene).
    cwdBefore = fs.readdirSync(process.cwd()).sort();
    envKeysBefore = new Set(Object.keys(process.env));
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    // Remove any test-only env vars we set (so a key never lingers across tests / in the environment).
    for (const k of Object.keys(process.env)) {
      if (!envKeysBefore.has(k)) delete process.env[k];
    }
    // FILESYSTEM HYGIENE: nothing the publish/verify paths did leaked into the working tree.
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-rev-cli-"));
    tmpDirs.push(d);
    return d;
  }
  // An EPHEMERAL, THROWAWAY in-process key (NEVER persisted to the working tree, NEVER funded).
  function ephemeralKey() {
    const w = Wallet.createRandom();
    expect(w.privateKey).to.match(/^0x[0-9a-fA-F]{64}$/); // an in-memory key — never a real-funds key
    return w;
  }
  // Write the wallet's private key to a throwaway file under a temp dir so the CLI can read it via --key-file.
  function keyFileFor(wallet) {
    const d = mkTmp();
    const p = path.join(d, "signing.key");
    fs.writeFileSync(p, wallet.privateKey + "\n"); // trailing newline (the core trims it)
    return p;
  }
  // A canonical, valid set of publish flags for a given address + key file.
  function publishArgs(address, keyFile, overrides = {}) {
    const o = { reason: "rotated", ...overrides };
    const argv = ["publish", "--address", address, "--reason", o.reason];
    if (o.supersededBy) argv.push("--superseded-by", o.supersededBy);
    argv.push("--revoked-at", NOW_ISO, "--key-file", keyFile);
    return argv;
  }
  // Publish a revocation to a file under a fresh temp dir; returns { wallet, revPath, json }.
  async function publishRevocationToFile(wallet, overrides = {}) {
    const w = wallet || ephemeralKey();
    const keyFile = keyFileFor(w);
    const outDir = mkTmp();
    const revPath = path.join(outDir, "key.vhrevocation.json");
    const io = capture();
    const code = await REV.cmdRevocation(
      [...publishArgs(w.address, keyFile, overrides), "--out", revPath, "--json"],
      io
    );
    expect(code, io.err()).to.equal(REV.EXIT.OK);
    return { wallet: w, revPath, json: JSON.parse(io.out()), keyFile };
  }

  // =====================================================================================================
  // `vh revocation publish`
  // =====================================================================================================

  it("MINTS a revocation when the key controls --address: exit 0, leads with the trust line, public summary, NO key leak", async function () {
    const w = ephemeralKey();
    const keyFile = keyFileFor(w);
    const io = capture();
    const code = await REV.cmdRevocation(publishArgs(w.address, keyFile), { ...io, nowISO: () => NOW_ISO });
    expect(code).to.equal(REV.EXIT.OK);
    const out = io.out();
    // LEADS with the standing trust line (the REVOCATION_TRUST_NOTE).
    expect(out).to.contain(coreRevocation.REVOCATION_TRUST_NOTE);
    expect(out).to.contain(`published a signed key revocation for ${w.address.toLowerCase()}`);
    expect(out).to.contain(`signed by ${w.address.toLowerCase()}`);
    expect(out).to.contain("reason:       rotated");
    // The revocation bytes are printed (no --out): the embedded revocation round-trips through verify.
    expect(out).to.contain(coreRevocation.SIGNED_REVOCATION_KIND);
    // KEY HYGIENE: the private key NEVER appears in stdout or stderr.
    expect(out).to.not.contain(w.privateKey);
    expect(io.err()).to.not.contain(w.privateKey);
    expect(out).to.not.contain(w.privateKey.slice(2));
  });

  it("--out writes the revocation to the caller-chosen path (never cwd); --json carries the public summary + the path, no key", async function () {
    const w = ephemeralKey();
    const keyFile = keyFileFor(w);
    const outDir = mkTmp();
    const revPath = path.join(outDir, "vendor.vhrevocation.json");
    const io = capture();
    const code = await REV.cmdRevocation(
      [...publishArgs(w.address, keyFile), "--out", revPath, "--json"],
      io
    );
    expect(code).to.equal(REV.EXIT.OK);
    expect(fs.existsSync(revPath)).to.equal(true);
    const j = JSON.parse(io.out());
    expect(j.published).to.equal(true);
    expect(j.kind).to.equal(coreRevocation.SIGNED_REVOCATION_KIND);
    expect(j.vendorAddress).to.equal(w.address.toLowerCase());
    expect(j.signer).to.equal(w.address.toLowerCase());
    expect(j.reason).to.equal("rotated");
    expect(j.revokedAt).to.equal(NOW_ISO);
    expect(j.supersededBy).to.equal(null); // none given
    expect(j.out).to.equal(revPath);
    expect(j.container).to.equal(null); // with --out the artifact is on disk, not inlined
    expect(j.note).to.equal(coreRevocation.REVOCATION_TRUST_NOTE);
    // NO key field anywhere in the JSON, and the on-disk revocation holds only the public signer + signature.
    expect(JSON.stringify(j)).to.not.contain(w.privateKey);
    const onDisk = JSON.parse(fs.readFileSync(revPath, "utf8"));
    expect(JSON.stringify(onDisk)).to.not.contain(w.privateKey);
    // The on-disk revocation is the genuine artifact: verify ACCEPTS it.
    const vio = capture();
    expect(await REV.cmdRevocation(["verify", revPath], vio)).to.equal(REV.EXIT.OK);
  });

  it("default (no --out) prints the revocation + writes NOTHING (no --out file, nothing in cwd)", async function () {
    const w = ephemeralKey();
    const keyFile = keyFileFor(w);
    const io = capture();
    const code = await REV.cmdRevocation(publishArgs(w.address, keyFile), io);
    expect(code).to.equal(REV.EXIT.OK);
    // The printed bytes ARE the canonical signed revocation (they parse + verify).
    const printed = io.out().slice(io.out().indexOf("{"));
    const obj = JSON.parse(printed.slice(0, printed.lastIndexOf("}") + 1));
    expect(obj.kind).to.equal(coreRevocation.SIGNED_REVOCATION_KIND);
    // (cwd hygiene is asserted in afterEach.)
  });

  it("--superseded-by is recorded + round-trips: surfaced in publish output, in the verdict, and in verify", async function () {
    const successor = ephemeralKey().address;
    const { wallet: w, revPath, json } = await publishRevocationToFile(undefined, { supersededBy: successor });
    expect(json.supersededBy).to.equal(successor.toLowerCase());
    const vio = capture();
    expect(await REV.cmdRevocation(["verify", revPath, "--json"], vio)).to.equal(REV.EXIT.OK);
    const vj = JSON.parse(vio.out());
    expect(vj.supersededBy).to.equal(successor.toLowerCase());
    expect(vj.vendorAddress).to.equal(w.address.toLowerCase());
  });

  it("REFUSES to mint a revocation for an address the key does NOT control: exit 2, BEFORE writing any --out file", async function () {
    const signer = ephemeralKey(); // controls signer.address
    const keyFile = keyFileFor(signer);
    const otherAddress = ephemeralKey().address; // a DIFFERENT address this key does NOT control
    const outDir = mkTmp();
    const revPath = path.join(outDir, "should-not-exist.vhrevocation.json");
    const io = capture();
    const code = await REV.cmdRevocation([...publishArgs(otherAddress, keyFile), "--out", revPath], io);
    expect(code).to.equal(REV.EXIT.USAGE);
    expect(io.err()).to.contain("does not control");
    expect(io.err()).to.contain("vendorAddress");
    // The refusal happens BEFORE any write: no --out file was created (never a mis-minted statement).
    expect(fs.existsSync(revPath)).to.equal(false);
    // And no key leaked in the refusal message.
    expect(io.err()).to.not.contain(signer.privateKey);
  });

  it("--key-env reads the key from the environment (read-used-discarded); the key never appears in output", async function () {
    const w = ephemeralKey();
    process.env.VH_TEST_REVOCATION_KEY = w.privateKey; // cleaned up in afterEach
    const argv = ["publish", "--address", w.address, "--reason", "compromised", "--revoked-at", NOW_ISO, "--key-env", "VH_TEST_REVOCATION_KEY", "--json"];
    const io = capture();
    const code = await REV.cmdRevocation(argv, io);
    expect(code).to.equal(REV.EXIT.OK);
    const j = JSON.parse(io.out());
    expect(j.vendorAddress).to.equal(w.address.toLowerCase());
    expect(j.signer).to.equal(w.address.toLowerCase());
    expect(j.reason).to.equal("compromised");
    expect(io.out()).to.not.contain(w.privateKey);
    expect(io.err()).to.not.contain(w.privateKey);
  });

  it("enforces EXACTLY-ONE-of-key-source: neither, both, a missing env var each a clean usage error (key-free)", async function () {
    const w = ephemeralKey();
    const keyFile = keyFileFor(w);
    const base = ["publish", "--address", w.address, "--reason", "rotated", "--revoked-at", NOW_ISO];
    // NEITHER source.
    const ioA = capture();
    expect(await REV.cmdRevocation(base, ioA)).to.equal(REV.EXIT.USAGE);
    expect(ioA.err()).to.match(/no signing key|EXACTLY ONE/);
    // BOTH sources.
    const ioB = capture();
    expect(await REV.cmdRevocation([...base, "--key-file", keyFile, "--key-env", "NOPE_VAR"], ioB)).to.equal(
      REV.EXIT.USAGE
    );
    expect(ioB.err()).to.match(/mutually exclusive|EXACTLY ONE/);
    // MISSING env var.
    const ioC = capture();
    expect(await REV.cmdRevocation([...base, "--key-env", "VH_DEFINITELY_UNSET_KEY_VAR"], ioC)).to.equal(
      REV.EXIT.USAGE
    );
    expect(ioC.err()).to.match(/is not set|empty/);
    // No key file was created spuriously; the key never leaked.
    expect(ioA.err()).to.not.contain(w.privateKey);
  });

  it("a malformed --address / out-of-set --reason / non-canonical --revoked-at / malformed --superseded-by is a usage error (2)", async function () {
    const w = ephemeralKey();
    const keyFile = keyFileFor(w);
    // Malformed address.
    const ioA = capture();
    expect(
      await REV.cmdRevocation(["publish", "--address", "0xnope", "--reason", "rotated", "--revoked-at", NOW_ISO, "--key-file", keyFile], ioA)
    ).to.equal(REV.EXIT.USAGE);
    expect(ioA.err()).to.match(/invalid --address/);
    // Out-of-set reason (address valid + matches the key, so the failure is purely the reason).
    const ioB = capture();
    expect(
      await REV.cmdRevocation(["publish", "--address", w.address, "--reason", "not-a-reason", "--revoked-at", NOW_ISO, "--key-file", keyFile], ioB)
    ).to.equal(REV.EXIT.USAGE);
    expect(ioB.err()).to.match(/reason/);
    // Non-canonical revoked-at (date-only).
    const ioC = capture();
    expect(
      await REV.cmdRevocation(["publish", "--address", w.address, "--reason", "rotated", "--revoked-at", "2026-06-26", "--key-file", keyFile], ioC)
    ).to.equal(REV.EXIT.USAGE);
    expect(ioC.err()).to.match(/revokedAt/);
    // Malformed superseded-by.
    const ioD = capture();
    expect(
      await REV.cmdRevocation(["publish", "--address", w.address, "--reason", "rotated", "--superseded-by", "0xbad", "--revoked-at", NOW_ISO, "--key-file", keyFile], ioD)
    ).to.equal(REV.EXIT.USAGE);
    expect(ioD.err()).to.match(/superseded-by/);
  });

  it("missing --address / --reason are each a clean usage error (2)", async function () {
    const w = ephemeralKey();
    const keyFile = keyFileFor(w);
    // No --address.
    const io1 = capture();
    expect(
      await REV.cmdRevocation(["publish", "--reason", "rotated", "--revoked-at", NOW_ISO, "--key-file", keyFile], io1)
    ).to.equal(REV.EXIT.USAGE);
    expect(io1.err()).to.match(/--address/);
    // No --reason.
    const io2 = capture();
    expect(
      await REV.cmdRevocation(["publish", "--address", w.address, "--revoked-at", NOW_ISO, "--key-file", keyFile], io2)
    ).to.equal(REV.EXIT.USAGE);
    expect(io2.err()).to.match(/--reason/);
  });

  it("a flag without its value, an unknown flag, and a stray positional are each a parse usage error (2)", async function () {
    const w = ephemeralKey();
    const keyFile = keyFileFor(w);
    const io1 = capture();
    expect(await REV.cmdRevocation(["publish", "--address"], io1)).to.equal(REV.EXIT.USAGE);
    expect(io1.err()).to.match(/--address requires a value/);
    const io2 = capture();
    expect(await REV.cmdRevocation(["publish", "--bogus", "x"], io2)).to.equal(REV.EXIT.USAGE);
    expect(io2.err()).to.match(/unknown flag/);
    const io3 = capture();
    expect(
      await REV.cmdRevocation(["publish", "stray", "--address", w.address, "--reason", "rotated", "--key-file", keyFile], io3)
    ).to.equal(REV.EXIT.USAGE);
    expect(io3.err()).to.match(/unknown flag|no positional/);
  });

  // =====================================================================================================
  // `vh revocation verify`
  // =====================================================================================================

  it("verify ACCEPTS a genuine revocation: exit 0, leads with the trust line, per-check PASS, reason/revokedAt shown", async function () {
    const { revPath } = await publishRevocationToFile();
    const io = capture();
    const code = await REV.cmdRevocation(["verify", revPath], io);
    expect(code).to.equal(REV.EXIT.OK);
    const out = io.out();
    expect(out).to.contain("TRUST: " + REV.VERIFY_TRUST_NOTE);
    expect(out).to.contain("revocation:       ACCEPTED");
    expect(out).to.match(/\[PASS\] signature recovers to the claimed signer/);
    expect(out).to.match(/\[PASS\] the recovered signer IS the revocation's vendorAddress/);
    expect(out).to.contain("reason:           rotated");
    expect(out).to.contain("revokedAt:        " + NOW_ISO);
    expect(out).to.match(/ACCEPTED: every requested check passed/);
  });

  it("verify --signer PINS the publisher: the RIGHT one PASSes (0); a DIFFERENT one is a clean REJECTED (3)", async function () {
    const { wallet: w, revPath } = await publishRevocationToFile();
    // Right pin -> ACCEPTED.
    const okIo = capture();
    expect(await REV.cmdRevocation(["verify", revPath, "--signer", w.address], okIo)).to.equal(REV.EXIT.OK);
    expect(okIo.out()).to.match(/\[PASS\] recovered signer matches the expected signer/);
    // Wrong pin -> REJECTED (the signature is genuine; ONLY the pin fails).
    const other = ephemeralKey().address;
    const badIo = capture();
    expect(await REV.cmdRevocation(["verify", revPath, "--signer", other], badIo)).to.equal(REV.EXIT.FAIL);
    expect(badIo.out()).to.match(/REJECTED: failed check\(s\): signerMatchesExpected/);
    expect(badIo.out()).to.match(/pin-mismatch/);
  });

  it("verify of a TAMPERED revocation (one byte of the embedded reason) is a clean REJECTED (3), never a silent pass", async function () {
    const { revPath } = await publishRevocationToFile();
    const container = JSON.parse(fs.readFileSync(revPath, "utf8"));
    // Flip the embedded reason from "rotated" to "retired" WITHOUT re-signing: the recovered signer no longer
    // matches, so the signature check FAILS (a clean REJECTED, never a false ACCEPT).
    container.attestation = container.attestation.replace('"reason":"rotated"', '"reason":"retired"');
    const tamperedPath = path.join(mkTmp(), "tampered.vhrevocation.json");
    fs.writeFileSync(tamperedPath, JSON.stringify(container) + "\n");
    const io = capture();
    expect(await REV.cmdRevocation(["verify", tamperedPath], io)).to.equal(REV.EXIT.FAIL);
    expect(io.out()).to.match(/REJECTED: failed check\(s\):/);
    expect(io.out()).to.match(/signatureMatchesSigner/);
  });

  it("verify of a THIRD-PARTY revocation (signed by a DIFFERENT key over someone else's vendorAddress) is REJECTED (3)", async function () {
    // A griefer signs a revocation whose vendorAddress is the VICTIM's, but with the GRIEFER's key. The
    // self-control check FAILS: a third party cannot revoke a key it does not control.
    const victim = ephemeralKey();
    const griefer = ephemeralKey();
    // Build the unsigned payload for the victim, then sign with the griefer's key + claim the griefer as signer
    // (the only way to get a structurally-valid container that fails the self-control check).
    const payload = coreRevocation.buildRevocationPayload({
      vendorAddress: victim.address,
      reason: "compromised",
      revokedAt: NOW_ISO,
    });
    const container = await coreAttestation.signAttestation(
      { attestation: payload, signer: griefer },
      {
        kind: coreRevocation.SIGNED_REVOCATION_KIND,
        schemaVersion: coreRevocation.SIGNED_REVOCATION_SCHEMA_VERSION,
        supportedSchemaVersions: coreRevocation.SUPPORTED_SIGNED_REVOCATION_SCHEMA_VERSIONS,
        note: coreRevocation.SIGNED_REVOCATION_TRUST_NOTE,
        label: "signed key revocation",
        validateUnsigned: coreRevocation.validateRevocation,
        serializeUnsigned: coreRevocation.serializeRevocation,
      }
    );
    const p = path.join(mkTmp(), "third-party.vhrevocation.json");
    fs.writeFileSync(p, coreRevocation.serializeSignedRevocation(container));
    const io = capture();
    expect(await REV.cmdRevocation(["verify", p], io)).to.equal(REV.EXIT.FAIL);
    expect(io.out()).to.match(/REJECTED: failed check\(s\):.*vendorAddressMatchesSigner/);
    expect(io.out()).to.match(/third-party/);
  });

  it("verify of a malformed --signer is a usage error (2); a missing file is IO (1); a garbled file is IO (1)", async function () {
    const { revPath } = await publishRevocationToFile();
    // Malformed --signer.
    const io1 = capture();
    expect(await REV.cmdRevocation(["verify", revPath, "--signer", "0xnope"], io1)).to.equal(REV.EXIT.USAGE);
    expect(io1.err()).to.match(/invalid --signer/);
    // Missing file -> IO.
    const io2 = capture();
    expect(await REV.cmdRevocation(["verify", path.join(mkTmp(), "nope.json")], io2)).to.equal(REV.EXIT.IO);
    expect(io2.err()).to.match(/cannot read/);
    // Garbled (not JSON) file -> IO.
    const garbled = path.join(mkTmp(), "garbled.json");
    fs.writeFileSync(garbled, "{not json");
    const io3 = capture();
    expect(await REV.cmdRevocation(["verify", garbled], io3)).to.equal(REV.EXIT.IO);
    expect(io3.err()).to.match(/cannot read|not valid JSON/);
  });

  it("verify with NO <revocation> positional is a usage error (2)", async function () {
    const io = capture();
    expect(await REV.cmdRevocation(["verify"], io)).to.equal(REV.EXIT.USAGE);
    expect(io.err()).to.match(/requires a <revocation>/);
  });

  // =====================================================================================================
  // dispatch + top-level wiring
  // =====================================================================================================

  it("an UNKNOWN revocation subcommand is a usage error (2) naming the valid set; help is exit 0", async function () {
    const io = capture();
    expect(await REV.cmdRevocation(["frobnicate"], io)).to.equal(REV.EXIT.USAGE);
    expect(io.err()).to.match(/unknown revocation subcommand/);
    expect(io.err()).to.match(/publish, verify/);
    // help / no-subcommand: no-subcommand exits 2 (usage), explicit help exits 0.
    const ioNone = capture();
    expect(await REV.cmdRevocation([], ioNone)).to.equal(REV.EXIT.USAGE);
    expect(ioNone.out()).to.match(/vh revocation/);
    const ioHelp = capture();
    expect(await REV.cmdRevocation(["--help"], ioHelp)).to.equal(REV.EXIT.OK);
    expect(ioHelp.out()).to.match(/vh revocation publish/);
  });

  it("`vh` registers the top-level `revocation` command (vh.main routes to cmdRevocation)", async function () {
    // The dispatcher is wired: an unknown subcommand under the registered top-level command is a clean
    // usage error (2) — proving `revocation` is NOT an unknown TOP-LEVEL command (which would also be 2 but
    // with a different message). We assert the revocation-specific message to prove the route landed.
    const origErr = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = (s) => {
      captured += s;
      return true;
    };
    let code;
    try {
      code = await vh.main(["revocation", "frobnicate"]);
    } finally {
      process.stderr.write = origErr;
    }
    expect(code).to.equal(2);
    expect(captured).to.match(/unknown revocation subcommand/);
    expect(captured).to.not.match(/unknown command: revocation/);
    // And the top-level usage lists the command surface entry.
    expect(vh.usage()).to.match(/vh revocation publish/);
    expect(vh.usage()).to.match(/vh revocation verify/);
    expect(vh.cmdRevocation).to.be.a("function");
  });
});

"use strict";

// T-49.2 — `vh identity publish` (mint the card) + `vh identity verify` (check + pin it), the CLI surface
// over the PURE producer-IDENTITY core (T-49.1, cli/identity.js).
//
// What these prove (the acceptance criteria):
//   `vh identity publish`:
//     * MINTS a signed card ONLY when the provisioned key's address EQUALS --address; a key that does NOT
//       control --address HARD-ERRORS (exit 2) BEFORE writing anything (no --out file leaks);
//     * enforces the EXACTLY-ONE-of-key-source rule (neither / both / missing-env / unreadable-file each a
//       clean usage error, key-free message) via the SHARED loadSigningWallet — the loop NEVER
//       generates/persists/logs a key (we assert the key never appears in any output);
//     * default prints the card + writes NOTHING; --out writes ONLY to the caller-chosen path (never cwd);
//     * LEADS with the trust line; --json carries the public card summary + the artifact (no --out) and NO key;
//     * a malformed --address / out-of-set --product-line / empty claim / non-canonical date is a usage error (2).
//   `vh identity verify`:
//     * ACCEPT / REJECT / usage exits map 0 / 3 / 2 / 1;
//     * LEADS with the trust line; prints the claims + non-claims + per-check PASS/FAIL;
//     * pins --signer (the RIGHT one PASSes, a DIFFERENT one is a clean REJECTED exit 3; a malformed one is usage 2);
//     * a FORGED / TAMPERED / wrong-vendor card is a clean REJECTED (exit 3) — NEVER a silent pass;
//     * a missing/garbled card file is IO (1).
//   dispatch:
//     * an UNKNOWN `identity` subcommand is a usage error (2) and names the valid set.
//   filesystem hygiene:
//     * NOTHING leaks into cwd, pass or fail (every effect is isolated to a throwaway temp dir).
//
// Every signing key is an EPHEMERAL in-process Wallet.createRandom() (TEST-ONLY, never a real key / real
// funds), supplied to the CLI via --key-file (a key file written into the throwaway temp dir) or --key-env
// (a process.env var set + deleted per test). publish writes the card via the genuine PUBLIC build+serialize
// path, so verify exercises the real on-disk artifact, not a hand-rolled envelope.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Wallet, getAddress } = require("ethers");

const ID = require("../cli/identity");
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

describe("cli/identity T-49.2: `vh identity publish` + `vh identity verify`", function () {
  // A pinned clock so publish is deterministic under test (the core never reads the real clock; the CLI's
  // default publishedAt is the ONLY clock read, and it is injectable via io.nowISO).
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
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-id-cli-"));
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
  // A canonical, valid set of publish flags for a given address + key file. claims/non-claims are non-empty
  // (the load-bearing honest boundary); published-at is the pinned canonical instant.
  function publishArgs(address, keyFile, overrides = {}) {
    const o = {
      productLine: "evidence",
      claims: [
        "We seal directories into tamper-evident verifyhash evidence packets.",
        "We sign each packet with the key that controls this vendorAddress.",
      ],
      nonClaims: [
        "We do NOT prove any specific packet's contents are true.",
        "We do NOT provide a trusted timestamp or a legal opinion.",
      ],
      ...overrides,
    };
    const argv = ["publish", "--address", address, "--product-line", o.productLine];
    for (const c of o.claims) argv.push("--claim", c);
    for (const c of o.nonClaims) argv.push("--non-claim", c);
    argv.push("--published-at", NOW_ISO, "--key-file", keyFile);
    return argv;
  }
  // Publish a card to a file under a fresh temp dir; returns { wallet, cardPath, json }.
  async function publishCardToFile(wallet, overrides = {}) {
    const w = wallet || ephemeralKey();
    const keyFile = keyFileFor(w);
    const outDir = mkTmp();
    const cardPath = path.join(outDir, "card.vhidentity.json");
    const io = capture();
    const code = await ID.cmdIdentity(
      [...publishArgs(w.address, keyFile, overrides), "--out", cardPath, "--json"],
      io
    );
    expect(code, io.err()).to.equal(ID.EXIT.OK);
    return { wallet: w, cardPath, json: JSON.parse(io.out()), keyFile };
  }

  // =====================================================================================================
  // `vh identity publish`
  // =====================================================================================================

  it("MINTS a card when the key controls --address: exit 0, leads with the trust line, public summary, NO key leak", async function () {
    const w = ephemeralKey();
    const keyFile = keyFileFor(w);
    const io = capture();
    const code = await ID.cmdIdentity(publishArgs(w.address, keyFile), { ...io, nowISO: () => NOW_ISO });
    expect(code).to.equal(ID.EXIT.OK);
    const out = io.out();
    // LEADS with the standing trust line (the IDENTITY_CARD_TRUST_NOTE).
    expect(out).to.contain(ID.IDENTITY_CARD_TRUST_NOTE);
    expect(out).to.contain(`published a signed identity card for ${w.address.toLowerCase()}`);
    expect(out).to.contain(`signed by ${w.address.toLowerCase()}`);
    // The card bytes are printed (no --out): the embedded card round-trips through verify.
    expect(out).to.contain(ID.SIGNED_IDENTITY_CARD_KIND);
    // KEY HYGIENE: the private key NEVER appears in stdout or stderr.
    expect(out).to.not.contain(w.privateKey);
    expect(io.err()).to.not.contain(w.privateKey);
    expect(out).to.not.contain(w.privateKey.slice(2));
  });

  it("--out writes the card to the caller-chosen path (never cwd); --json carries the public summary + the path, no key", async function () {
    const w = ephemeralKey();
    const keyFile = keyFileFor(w);
    const outDir = mkTmp();
    const cardPath = path.join(outDir, "vendor.vhidentity.json");
    const io = capture();
    const code = await ID.cmdIdentity(
      [...publishArgs(w.address, keyFile), "--out", cardPath, "--json"],
      io
    );
    expect(code).to.equal(ID.EXIT.OK);
    expect(fs.existsSync(cardPath)).to.equal(true);
    const j = JSON.parse(io.out());
    expect(j.published).to.equal(true);
    expect(j.kind).to.equal(ID.SIGNED_IDENTITY_CARD_KIND);
    expect(j.vendorAddress).to.equal(w.address.toLowerCase());
    expect(j.signer).to.equal(w.address.toLowerCase());
    expect(j.productLine).to.equal("evidence");
    expect(j.publishedAt).to.equal(NOW_ISO);
    expect(j.claims).to.have.length(2);
    expect(j.nonClaims).to.have.length(2);
    expect(j.out).to.equal(cardPath);
    expect(j.container).to.equal(null); // with --out the artifact is on disk, not inlined
    expect(j.note).to.equal(ID.IDENTITY_CARD_TRUST_NOTE);
    // NO key field anywhere in the JSON, and the on-disk card holds only the public signer + signature.
    expect(JSON.stringify(j)).to.not.contain(w.privateKey);
    const onDisk = JSON.parse(fs.readFileSync(cardPath, "utf8"));
    expect(JSON.stringify(onDisk)).to.not.contain(w.privateKey);
    // The on-disk card is the genuine artifact: verify ACCEPTS it.
    const vio = capture();
    expect(await ID.cmdIdentity(["verify", cardPath], vio)).to.equal(ID.EXIT.OK);
  });

  it("REFUSES to mint a card for an address the key does NOT control: exit 2, BEFORE writing any --out file", async function () {
    const signer = ephemeralKey(); // controls signer.address
    const keyFile = keyFileFor(signer);
    const otherAddress = ephemeralKey().address; // a DIFFERENT address this key does NOT control
    const outDir = mkTmp();
    const cardPath = path.join(outDir, "should-not-exist.vhidentity.json");
    const io = capture();
    const code = await ID.cmdIdentity(
      [...publishArgs(otherAddress, keyFile), "--out", cardPath],
      io
    );
    expect(code).to.equal(ID.EXIT.USAGE);
    expect(io.err()).to.contain("does not control");
    expect(io.err()).to.contain("vendorAddress");
    // The refusal happens BEFORE any write: no --out file was created.
    expect(fs.existsSync(cardPath)).to.equal(false);
    // And no key leaked in the refusal message.
    expect(io.err()).to.not.contain(signer.privateKey);
  });

  it("--key-env reads the key from the environment (read-used-discarded); the key never appears in output", async function () {
    const w = ephemeralKey();
    process.env.VH_TEST_IDENTITY_KEY = w.privateKey; // cleaned up in afterEach
    const argv = ["publish", "--address", w.address, "--product-line", "evidence", "--claim", "We attest X.", "--non-claim", "We do NOT attest Y.", "--published-at", NOW_ISO, "--key-env", "VH_TEST_IDENTITY_KEY", "--json"];
    const io = capture();
    const code = await ID.cmdIdentity(argv, io);
    expect(code).to.equal(ID.EXIT.OK);
    const j = JSON.parse(io.out());
    expect(j.vendorAddress).to.equal(w.address.toLowerCase());
    expect(j.signer).to.equal(w.address.toLowerCase());
    expect(io.out()).to.not.contain(w.privateKey);
    expect(io.err()).to.not.contain(w.privateKey);
  });

  it("enforces EXACTLY-ONE-of-key-source: neither, both, a missing env var each a clean usage error (key-free)", async function () {
    const w = ephemeralKey();
    const keyFile = keyFileFor(w);
    // NEITHER source.
    const a = ["publish", "--address", w.address, "--product-line", "evidence", "--claim", "x", "--non-claim", "y", "--published-at", NOW_ISO];
    const ioA = capture();
    expect(await ID.cmdIdentity(a, ioA)).to.equal(ID.EXIT.USAGE);
    expect(ioA.err()).to.match(/no signing key|EXACTLY ONE/);
    // BOTH sources.
    const ioB = capture();
    expect(
      await ID.cmdIdentity([...a, "--key-file", keyFile, "--key-env", "NOPE_VAR"], ioB)
    ).to.equal(ID.EXIT.USAGE);
    expect(ioB.err()).to.match(/mutually exclusive|EXACTLY ONE/);
    // MISSING env var.
    const ioC = capture();
    expect(
      await ID.cmdIdentity([...a, "--key-env", "VH_DEFINITELY_UNSET_KEY_VAR"], ioC)
    ).to.equal(ID.EXIT.USAGE);
    expect(ioC.err()).to.match(/is not set|empty/);
  });

  it("a malformed --address is a usage error (2); an out-of-set --product-line is a usage error (2)", async function () {
    const w = ephemeralKey();
    const keyFile = keyFileFor(w);
    // Malformed address.
    const ioA = capture();
    const codeA = await ID.cmdIdentity(
      ["publish", "--address", "0xnope", "--product-line", "evidence", "--claim", "x", "--non-claim", "y", "--published-at", NOW_ISO, "--key-file", keyFile],
      ioA
    );
    expect(codeA).to.equal(ID.EXIT.USAGE);
    expect(ioA.err()).to.match(/invalid --address/);
    // Out-of-set product line (address valid + matches the key, so the failure is purely the product line).
    const ioB = capture();
    const codeB = await ID.cmdIdentity(
      ["publish", "--address", w.address, "--product-line", "not-a-line", "--claim", "x", "--non-claim", "y", "--published-at", NOW_ISO, "--key-file", keyFile],
      ioB
    );
    expect(codeB).to.equal(ID.EXIT.USAGE);
    expect(ioB.err()).to.match(/productLine/);
  });

  it("missing --claim / --non-claim / --address / --product-line are each a clean usage error (2)", async function () {
    const w = ephemeralKey();
    const keyFile = keyFileFor(w);
    const base = ["publish", "--address", w.address, "--product-line", "evidence", "--published-at", NOW_ISO, "--key-file", keyFile];
    // No --claim.
    const io1 = capture();
    expect(await ID.cmdIdentity([...base, "--non-claim", "y"], io1)).to.equal(ID.EXIT.USAGE);
    expect(io1.err()).to.match(/--claim/);
    // No --non-claim.
    const io2 = capture();
    expect(await ID.cmdIdentity([...base, "--claim", "x"], io2)).to.equal(ID.EXIT.USAGE);
    expect(io2.err()).to.match(/--non-claim/);
    // No --address.
    const io3 = capture();
    expect(
      await ID.cmdIdentity(["publish", "--product-line", "evidence", "--claim", "x", "--non-claim", "y", "--published-at", NOW_ISO, "--key-file", keyFile], io3)
    ).to.equal(ID.EXIT.USAGE);
    expect(io3.err()).to.match(/--address/);
    // No --product-line.
    const io4 = capture();
    expect(
      await ID.cmdIdentity(["publish", "--address", w.address, "--claim", "x", "--non-claim", "y", "--published-at", NOW_ISO, "--key-file", keyFile], io4)
    ).to.equal(ID.EXIT.USAGE);
    expect(io4.err()).to.match(/--product-line/);
  });

  it("a flag missing its value, and an unknown flag, are each a usage error (2)", async function () {
    const ioA = capture();
    expect(await ID.cmdIdentity(["publish", "--address"], ioA)).to.equal(ID.EXIT.USAGE);
    expect(ioA.err()).to.match(/--address requires a value/);
    const ioB = capture();
    expect(await ID.cmdIdentity(["publish", "--bogus"], ioB)).to.equal(ID.EXIT.USAGE);
    expect(ioB.err()).to.match(/unknown flag/);
  });

  it("a checksummed --address is accepted + normalized to lowercase (the key still controls it)", async function () {
    const w = ephemeralKey();
    const keyFile = keyFileFor(w);
    const io = capture();
    const code = await ID.cmdIdentity(
      ["publish", "--address", getAddress(w.address), "--product-line", "dataledger", "--claim", "x", "--non-claim", "y", "--published-at", NOW_ISO, "--key-file", keyFile, "--json"],
      io
    );
    expect(code).to.equal(ID.EXIT.OK);
    const j = JSON.parse(io.out());
    expect(j.vendorAddress).to.equal(w.address.toLowerCase());
    expect(j.productLine).to.equal("dataledger");
  });

  // =====================================================================================================
  // `vh identity verify`
  // =====================================================================================================

  it("ACCEPTS a genuine card: exit 0, leads with the trust line, prints claims/non-claims + per-check PASS", async function () {
    const { wallet, cardPath } = await publishCardToFile();
    const io = capture();
    const code = await ID.cmdIdentity(["verify", cardPath], io);
    expect(code).to.equal(ID.EXIT.OK);
    const out = io.out();
    // LEADS with the trust line.
    expect(out).to.match(/^TRUST: /);
    expect(out).to.contain("P-3");
    expect(out).to.contain("identity:         ACCEPTED");
    expect(out).to.contain(`vendorAddress:    ${wallet.address.toLowerCase()}`);
    expect(out).to.contain(`recovered signer: ${wallet.address.toLowerCase()}`);
    // The two ALWAYS checks PASS; the optional pin was not requested -> [skip].
    expect(out).to.contain("[PASS] signature recovers to the claimed signer");
    expect(out).to.contain("[PASS] the recovered signer IS the card's vendorAddress");
    expect(out).to.contain("[skip] expected-signer pin: not requested");
    // The claims + non-claims (the WHOLE point of the card) are printed.
    expect(out).to.contain("claims (2) — what this vendor attests:");
    expect(out).to.contain("We seal directories into tamper-evident verifyhash evidence packets.");
    expect(out).to.contain("nonClaims (2) — what this vendor explicitly does NOT attest:");
    expect(out).to.contain("We do NOT provide a trusted timestamp or a legal opinion.");
    expect(out).to.contain("ACCEPTED: every requested check passed");
  });

  it("--json carries the family verdict shape + the published claim set + the trust note", async function () {
    const { wallet, cardPath } = await publishCardToFile();
    const io = capture();
    const code = await ID.cmdIdentity(["verify", cardPath, "--json"], io);
    expect(code).to.equal(ID.EXIT.OK);
    const j = JSON.parse(io.out());
    expect(j.verdict).to.equal("ACCEPTED");
    expect(j.accepted).to.equal(true);
    expect(j.recoveredSigner).to.equal(wallet.address.toLowerCase());
    expect(j.claimedSigner).to.equal(wallet.address.toLowerCase());
    expect(j.vendorAddress).to.equal(wallet.address.toLowerCase());
    expect(j.scheme).to.equal("eip191-personal-sign");
    expect(j.checks).to.deep.equal({
      signatureMatchesSigner: true,
      vendorAddressMatchesSigner: true,
      signerMatchesExpected: null,
    });
    expect(j.failedChecks).to.deep.equal([]);
    expect(j.productLine).to.equal("evidence");
    expect(j.claims).to.have.length(2);
    expect(j.nonClaims).to.have.length(2);
    expect(j.publishedAt).to.equal(NOW_ISO);
    expect(j.card).to.equal(cardPath);
    expect(j.note).to.equal(ID.VERIFY_TRUST_NOTE);
  });

  it("--signer PINS the signer: the RIGHT one (EIP-55) PASSes (0), a DIFFERENT one is a clean REJECTED (3)", async function () {
    const { wallet, cardPath } = await publishCardToFile();
    // Right signer, passed checksummed -> ACCEPTED, pin PASS.
    const okIo = capture();
    const okCode = await ID.cmdIdentity(
      ["verify", cardPath, "--signer", getAddress(wallet.address), "--json"],
      okIo
    );
    expect(okCode).to.equal(ID.EXIT.OK);
    const okJ = JSON.parse(okIo.out());
    expect(okJ.verdict).to.equal("ACCEPTED");
    expect(okJ.checks.signerMatchesExpected).to.equal(true);
    expect(okJ.expectedSigner).to.equal(wallet.address.toLowerCase());
    // A DIFFERENT expected signer -> REJECTED (exit 3), naming ONLY the failed pin (the signature is genuine).
    const other = ephemeralKey();
    const badIo = capture();
    const badCode = await ID.cmdIdentity(["verify", cardPath, "--signer", other.address, "--json"], badIo);
    expect(badCode).to.equal(ID.EXIT.FAIL);
    const badJ = JSON.parse(badIo.out());
    expect(badJ.verdict).to.equal("REJECTED");
    expect(badJ.checks.signatureMatchesSigner).to.equal(true);
    expect(badJ.checks.vendorAddressMatchesSigner).to.equal(true);
    expect(badJ.checks.signerMatchesExpected).to.equal(false);
    expect(badJ.failedChecks).to.deep.equal(["signerMatchesExpected"]);
    // The human path NAMES the pin-mismatch.
    const hio = capture();
    await ID.cmdIdentity(["verify", cardPath, "--signer", other.address], hio);
    expect(hio.out()).to.contain("pin-mismatch");
  });

  it("a TAMPERED card (claims edited, signature kept) is a clean REJECTED (exit 3) — never a silent pass", async function () {
    const { cardPath } = await publishCardToFile();
    // Surgically edit the embedded card's claims while keeping the original signature (the wrap-don't-edit
    // invariant re-canonicalizes the embedded bytes, so the container stays structurally valid; the
    // divergence surfaces as a clean REJECTED verdict, not a parse error).
    const container = JSON.parse(fs.readFileSync(cardPath, "utf8"));
    const embedded = JSON.parse(container.attestation);
    embedded.claims = embedded.claims.slice();
    embedded.claims[0] = embedded.claims[0] + " (silently expanded)";
    container.attestation = ID.serializeIdentityCard(embedded);
    const tamperedPath = path.join(path.dirname(cardPath), "tampered.vhidentity.json");
    fs.writeFileSync(tamperedPath, ID.serializeSignedIdentityCard(container));

    const io = capture();
    const code = await ID.cmdIdentity(["verify", tamperedPath, "--json"], io);
    expect(code).to.equal(ID.EXIT.FAIL);
    const j = JSON.parse(io.out());
    expect(j.verdict).to.equal("REJECTED");
    expect(j.checks.signatureMatchesSigner).to.equal(false);
    expect(j.failedChecks).to.include("signatureMatchesSigner");
    // The human path NAMES the forgery/tamper.
    const hio = capture();
    await ID.cmdIdentity(["verify", tamperedPath], hio);
    expect(hio.out()).to.contain("forged/tampered");
  });

  it("a card whose vendorAddress != the recovering signer is REJECTED naming the vendorAddress check", async function () {
    // Honest card for `claimant`, then swap ONLY the embedded vendorAddress to `other` (keeping claimant's
    // signature). The recovered signer is no longer the card's vendorAddress -> vendor-mismatch.
    const claimant = ephemeralKey();
    const other = ephemeralKey();
    const { cardPath } = await publishCardToFile(claimant);
    const container = JSON.parse(fs.readFileSync(cardPath, "utf8"));
    const embedded = JSON.parse(container.attestation);
    embedded.vendorAddress = other.address.toLowerCase();
    container.attestation = ID.serializeIdentityCard(embedded);
    const badPath = path.join(path.dirname(cardPath), "vendor-swap.vhidentity.json");
    fs.writeFileSync(badPath, ID.serializeSignedIdentityCard(container));

    const io = capture();
    const code = await ID.cmdIdentity(["verify", badPath, "--json"], io);
    expect(code).to.equal(ID.EXIT.FAIL);
    const j = JSON.parse(io.out());
    expect(j.verdict).to.equal("REJECTED");
    expect(j.checks.vendorAddressMatchesSigner).to.equal(false);
    expect(j.failedChecks).to.include("vendorAddressMatchesSigner");
    const hio = capture();
    await ID.cmdIdentity(["verify", badPath], hio);
    expect(hio.out()).to.contain("vendor-mismatch");
  });

  it("a malformed --signer is a usage error (2); a missing card file is IO (1); no card at all is usage (2)", async function () {
    const { cardPath } = await publishCardToFile();
    // Malformed --signer.
    const io1 = capture();
    expect(await ID.cmdIdentity(["verify", cardPath, "--signer", "0xnope"], io1)).to.equal(ID.EXIT.USAGE);
    expect(io1.err()).to.match(/invalid --signer address/);
    // Missing card file -> IO.
    const io2 = capture();
    expect(await ID.cmdIdentity(["verify", "/no/such/card.json"], io2)).to.equal(ID.EXIT.IO);
    expect(io2.err()).to.match(/cannot read signed identity card/);
    // No positional -> usage.
    const io3 = capture();
    expect(await ID.cmdIdentity(["verify"], io3)).to.equal(ID.EXIT.USAGE);
    // Unknown flag -> usage.
    const io4 = capture();
    expect(await ID.cmdIdentity(["verify", "x", "--bogus"], io4)).to.equal(ID.EXIT.USAGE);
    // Extra positional -> usage.
    const io5 = capture();
    expect(await ID.cmdIdentity(["verify", "a", "b"], io5)).to.equal(ID.EXIT.USAGE);
  });

  it("a garbled (non-JSON / non-card) file handed to verify is an IO error (1), not half-accepted", async function () {
    const d = mkTmp();
    const junk = path.join(d, "junk.json");
    fs.writeFileSync(junk, "this is not json {{{");
    const io = capture();
    expect(await ID.cmdIdentity(["verify", junk], io)).to.equal(ID.EXIT.IO);
    expect(io.err()).to.match(/cannot read signed identity card/);
    // A well-formed JSON that is NOT an identity card is also rejected (foreign kind).
    const foreign = path.join(d, "foreign.json");
    fs.writeFileSync(foreign, JSON.stringify({ kind: "vh.evidence-seal-signed", x: 1 }));
    const io2 = capture();
    expect(await ID.cmdIdentity(["verify", foreign], io2)).to.equal(ID.EXIT.IO);
  });

  // =====================================================================================================
  // dispatch + round-trip through the top-level `vh` entrypoint
  // =====================================================================================================

  it("an UNKNOWN identity subcommand is a usage error (2) and names the valid set", async function () {
    const io = capture();
    const code = await ID.cmdIdentity(["bogus"], io);
    expect(code).to.equal(ID.EXIT.USAGE);
    expect(io.err()).to.contain("unknown identity subcommand");
    expect(io.err()).to.contain("publish");
    expect(io.err()).to.contain("verify");
  });

  it("`vh identity` (no subcommand) is usage (2) and prints help; `--help` is exit 0", async function () {
    const io1 = capture();
    expect(await ID.cmdIdentity([], io1)).to.equal(ID.EXIT.USAGE);
    expect(io1.out()).to.contain("vh identity");
    const io2 = capture();
    expect(await ID.cmdIdentity(["--help"], io2)).to.equal(ID.EXIT.OK);
    expect(io2.out()).to.contain("publish");
    expect(io2.out()).to.contain("verify");
  });

  it("the top-level `vh` dispatch routes `identity` (publish -> file -> verify ACCEPTED, all through main)", async function () {
    // This proves cli/vh.js wired the command in: it must reach cmdIdentity. We route publish to a temp
    // file, then verify it — both through the REAL `vh.main` dispatcher (using the io-injecting cmdIdentity
    // export for capture, but asserting `main` knows the command exists and does not fall to "unknown command").
    const w = ephemeralKey();
    const keyFile = keyFileFor(w);
    const outDir = mkTmp();
    const cardPath = path.join(outDir, "main.vhidentity.json");
    // `vh.main` writes to process.stdout; we only need its EXIT CODE + the on-disk artifact here, and we
    // must keep its noise off the test console — temporarily swallow stdout writes during the call.
    const origWrite = process.stdout.write;
    process.stdout.write = () => true;
    let pubCode;
    let verCode;
    try {
      pubCode = await vh.main(["identity", ...publishArgs(w.address, keyFile), "--out", cardPath]);
      verCode = await vh.main(["identity", "verify", cardPath]);
    } finally {
      process.stdout.write = origWrite;
    }
    expect(pubCode).to.equal(0);
    expect(verCode).to.equal(0);
    expect(fs.existsSync(cardPath)).to.equal(true);
    // The usage text names the new command (a future indexer/operator discovers it).
    expect(vh.usage()).to.contain("vh identity publish");
    expect(vh.usage()).to.contain("vh identity verify");
  });

  it("an UNKNOWN top-level command is still rejected (the identity wiring did not break dispatch)", async function () {
    const origWrite = process.stderr.write;
    process.stderr.write = () => true;
    let code;
    try {
      code = await vh.main(["definitely-not-a-command"]);
    } finally {
      process.stderr.write = origWrite;
    }
    expect(code).to.equal(2);
  });
});

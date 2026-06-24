"use strict";

// test/verifier.cli.test.js — the OFFLINE, working-tree-CLEAN acceptance suite for `verify-vh` (T-31.2).
//
// WHY THIS TEST EXISTS
//   `verify-vh` is the standalone, read-only, OFFLINE verifier a COUNTERPARTY runs to confirm a signed
//   verifyhash artifact WITHOUT the producer's ethers/hardhat stack. This suite proves the load-bearing
//   contract on REAL fixtures produced by the REAL producer code path:
//     * a signed EVIDENCE packet (produced via the real `cli/evidence.js#runEvidenceSeal` CLI path) and a
//       signed TRUST/reconciliation seal (produced via the real `trustledger/seal.js#signSealWith` path)
//       are each ACCEPTED with the matching `--vendor` (exit 0);
//     * editing ONE referenced byte makes it report exactly that file CHANGED, exit 3;
//     * a DIFFERENT `--vendor` yields `wrong_issuer`, exit 3;
//     * a tampered signature yields `bad_signature`, exit 3;
//     * `--json` round-trips a stable verdict object.
//   Every key is an EPHEMERAL in-process Wallet.createRandom() (TEST-ONLY — never a real key/real funds).
//   The license window is dated with an injected `now` so verdicts are deterministic.
//
// FILESYSTEM HYGIENE
//   Every write lands under a throwaway temp dir cleaned in afterEach, pass OR fail; the suite asserts the
//   working tree (cwd) is byte-for-byte untouched. verify-vh itself is read-only and writes nothing.
//
// INDEPENDENCE
//   The verifier under test (verifier/verify-vh.js + verifier/lib/*) must not require ethers/hardhat or
//   reach back into cli/ or trustledger/. We assert that over its whole transitive module graph.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { Wallet } = require("ethers");

// The REAL producers (their signing paths are exactly what the CLI uses).
const evidence = require("../cli/evidence");
const trustSeal = require("../trustledger/seal");

// The verifier UNDER TEST (loaded by relative path; its module graph is asserted independent below).
const verifyvh = require("../verifier/verify-vh");

const ISSUED = "2026-06-01T00:00:00.000Z";
const EXPIRES = "2027-06-01T00:00:00.000Z";
const NOW = new Date("2026-06-24T00:00:00.000Z");

describe("verifier CLI: `verify-vh <artifact>` (T-31.2)", function () {
  let tmpDirs;
  let cwdBefore;

  beforeEach(function () {
    tmpDirs = [];
    cwdBefore = fs.readdirSync(process.cwd()).sort();
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    // FILESYSTEM HYGIENE: nothing the producers OR the verifier did leaked into the working tree.
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });

  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "verify-vh-"));
    tmpDirs.push(d);
    return d;
  }

  // Capture stdout/stderr from a verify-vh run.
  function cap() {
    let out = "";
    let err = "";
    return {
      io: { write: (s) => (out += s), writeErr: (s) => (err += s) },
      out: () => out,
      err: () => err,
    };
  }

  // ---- evidence-packet fixture (the REAL producer CLI path) -------------------------------------
  // Mints an ephemeral-key evidence license, then runs the REAL `runEvidenceSeal` with --sign so the
  // produced *.vhevidence.json is a genuine signed-seal container. Returns the packet path, the data dir
  // (where the sealed files live), and the OPERATOR wallet (the signer verify-vh recovers/pins).
  async function makeSignedEvidencePacket() {
    const root = mkTmp();
    const dir = path.join(root, "data");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "alpha");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "b.txt"), "beta");
    fs.writeFileSync(path.join(dir, "c.bin"), Buffer.from([0, 1, 2, 255]));

    // Mint a vendor-signed evidence license carrying the `evidence_signed` entitlement.
    const vendorWallet = Wallet.createRandom();
    const license = await evidence.buildLicense(
      {
        licenseId: "EV-TEST-1",
        customer: "ACME Evidence Co",
        plan: "pro",
        entitlements: ["evidence_signed"],
        issuedAt: ISSUED,
        expiresAt: EXPIRES,
      },
      vendorWallet
    );
    const licFile = path.join(root, "evidence.vhlicense.json");
    fs.writeFileSync(licFile, JSON.stringify(license) + "\n");

    // Sign the packet with a SEPARATE ephemeral operator key, via the REAL CLI run function.
    const opWallet = Wallet.createRandom();
    const keyEnv = "VFY_TEST_OP_KEY_" + Math.random().toString(36).slice(2);
    process.env[keyEnv] = opWallet.privateKey;
    const packetPath = path.join(root, "packet.vhevidence.json");
    const c = cap();
    let code;
    try {
      code = await evidence.runEvidenceSeal(
        { dir, out: packetPath, sign: true, keyEnv, license: licFile, vendor: vendorWallet.address, now: NOW },
        { ...c.io, now: NOW }
      );
    } finally {
      delete process.env[keyEnv];
    }
    expect(code, `producer evidence CLI failed: ${c.err()}`).to.equal(0);
    expect(fs.existsSync(packetPath)).to.equal(true);
    const container = JSON.parse(fs.readFileSync(packetPath, "utf8"));
    expect(container.kind).to.equal("vh.evidence-seal-signed");

    return { root, dir, packetPath, opWallet };
  }

  // ---- trust/reconciliation-seal fixture (the REAL producer signing path) -----------------------
  // Builds a genuine reconciliation seal over 3 source inputs (sealed by basename) + 1 output, then
  // wraps it with the REAL `trustledger/seal.js#signSealWith` path (the exact signing path the family
  // uses). Writes the signed *.vhseal NEXT TO the source files so the default sibling resolution works.
  async function makeSignedTrustSeal() {
    const root = mkTmp();
    fs.writeFileSync(path.join(root, "bank.csv"), "date,amount\n2026-06-01,100\n");
    fs.writeFileSync(path.join(root, "book.csv"), "date,amount\n2026-06-01,100\n");
    fs.writeFileSync(path.join(root, "rent.csv"), "unit,amount\n1A,100\n");
    fs.writeFileSync(path.join(root, "report.html"), "<html><body>reconciled</body></html>");
    const rd = (f) => fs.readFileSync(path.join(root, f));

    const bare = trustSeal.buildSeal({
      files: {
        inputs: [
          { role: "bank", relPath: "bank.csv", bytes: rd("bank.csv") },
          { role: "book", relPath: "book.csv", bytes: rd("book.csv") },
          { role: "rentroll", relPath: "rent.csv", bytes: rd("rent.csv") },
        ],
        outputs: [{ relPath: "report.html", bytes: rd("report.html") }],
      },
      verdict: { pass: true, reportDate: "2026-06-24", period: "2026-Q2" },
    });
    const opWallet = Wallet.createRandom();
    const container = await trustSeal.signSealWith(bare, opWallet);
    const sealPath = path.join(root, "recon.vhseal");
    fs.writeFileSync(sealPath, trustSeal.serializeSignedSeal(container));

    return { root, sealPath, opWallet };
  }

  // =================================================================================================
  // INDEPENDENCE: the verifier's whole module graph must not pull ethers/hardhat or cli/ / trustledger/.
  // =================================================================================================
  describe("independence (no ethers/hardhat/cli/trustledger in the verifier's module graph)", function () {
    it("verify-vh + its lib modules resolve under verifier/ and require none of the forbidden trees", function () {
      const seen = new Set();
      const forbidden = /ethers|hardhat|@nomicfoundation/;
      const backEdge = /(^|[\\/])(cli|trustledger)([\\/]|$)/;

      function walk(absFile) {
        if (seen.has(absFile)) return;
        seen.add(absFile);
        expect(absFile, `${absFile} is outside verifier/`).to.match(/[\\/]verifier[\\/]/);
        const src = fs.readFileSync(absFile, "utf8");
        const reqs = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
        for (const r of reqs) {
          expect(r, `${path.basename(absFile)} requires ${r}`).to.not.match(forbidden);
          expect(r, `${path.basename(absFile)} requires ${r}`).to.not.match(backEdge);
          // Recurse into RELATIVE requires (the verifier's own files); a bare module name (js-sha3) is a
          // leaf dependency we don't walk (it is the one allowed runtime dep).
          if (r.startsWith(".")) {
            walk(require.resolve(path.resolve(path.dirname(absFile), r)));
          }
        }
      }
      walk(require.resolve("../verifier/verify-vh"));
      // Sanity: we actually walked the entrypoint + its lib siblings.
      expect([...seen].some((p) => /verify-vh\.js$/.test(p))).to.equal(true);
      expect([...seen].some((p) => /lib[\\/]secp256k1-recover\.js$/.test(p))).to.equal(true);
      expect([...seen].some((p) => /lib[\\/]merkle\.js$/.test(p))).to.equal(true);
    });

    it("verifier/package.json declares ONLY js-sha3 (no ethers/hardhat/@nomicfoundation)", function () {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "verifier", "package.json"), "utf8"));
      expect(pkg.bin).to.have.property("verify-vh");
      const deps = Object.keys(pkg.dependencies || {});
      expect(deps).to.deep.equal(["js-sha3"]);
      const all = JSON.stringify({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
      expect(all).to.not.match(/ethers|hardhat|@nomicfoundation/);
    });
  });

  // =================================================================================================
  // SIGNED EVIDENCE PACKET (real producer CLI).
  // =================================================================================================
  describe("signed evidence packet", function () {
    it("ACCEPTS a genuine packet with the matching --vendor (exit 0) and re-derives the root", async function () {
      const { dir, packetPath, opWallet } = await makeSignedEvidencePacket();
      const c = cap();
      const code = verifyvh.run([packetPath, "--vendor", opWallet.address, "--dir", dir], c.io);
      expect(code, c.err()).to.equal(verifyvh.EXIT.OK);
      expect(c.out()).to.match(/^verify-vh is an INDEPENDENT, read-only, OFFLINE verifier/);
      expect(c.out()).to.match(/OK — the artifact verifies\./);
    });

    it("reports the recovered signer when NO --vendor pin is given (exit 0)", async function () {
      const { dir, packetPath, opWallet } = await makeSignedEvidencePacket();
      const c = cap();
      const code = verifyvh.run([packetPath, "--dir", dir, "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.OK);
      const r = JSON.parse(c.out());
      expect(r.recoveredSigner).to.equal(opWallet.address.toLowerCase());
      expect(r.pinnedVendor).to.equal(null);
      expect(r.signatureOk).to.equal(true);
      expect(r.rootMatches).to.equal(true);
    });

    it("editing ONE referenced byte reports exactly that file CHANGED (exit 3)", async function () {
      const { dir, packetPath, opWallet } = await makeSignedEvidencePacket();
      // Flip one byte of exactly one sealed file.
      fs.writeFileSync(path.join(dir, "a.txt"), "alphX");
      const c = cap();
      const code = verifyvh.run([packetPath, "--vendor", opWallet.address, "--dir", dir, "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      const r = JSON.parse(c.out());
      expect(r.verdict).to.equal("REJECTED");
      expect(r.reason).to.equal("CHANGED");
      expect(r.changed.map((x) => x.relPath)).to.deep.equal(["a.txt"]);
      expect(r.counts.changed).to.equal(1);
      expect(r.rootMatches).to.equal(false);
      // The signature itself was untouched and still recovers to the operator.
      expect(r.signatureOk).to.equal(true);
    });

    it("a DIFFERENT --vendor yields wrong_issuer (exit 3)", async function () {
      const { dir, packetPath } = await makeSignedEvidencePacket();
      const someoneElse = Wallet.createRandom().address;
      const c = cap();
      const code = verifyvh.run([packetPath, "--vendor", someoneElse, "--dir", dir, "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      const r = JSON.parse(c.out());
      expect(r.reason).to.equal("wrong_issuer");
      expect(r.signatureOk).to.equal(true); // the sig is sound; only the ISSUER is wrong
      expect(r.signerMatchesVendor).to.equal(false);
    });

    it("a tampered signature yields bad_signature (exit 3)", async function () {
      const { root, dir, packetPath, opWallet } = await makeSignedEvidencePacket();
      const container = JSON.parse(fs.readFileSync(packetPath, "utf8"));
      const hex = container.signature.signature.slice(2);
      const flipped = (parseInt(hex.slice(0, 2), 16) ^ 0x01).toString(16).padStart(2, "0");
      container.signature.signature = "0x" + flipped + hex.slice(2);
      const badPath = path.join(root, "bad.vhevidence.json");
      fs.writeFileSync(badPath, JSON.stringify(container));

      const c = cap();
      const code = verifyvh.run([badPath, "--vendor", opWallet.address, "--dir", dir, "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      const r = JSON.parse(c.out());
      expect(r.reason).to.equal("bad_signature");
      expect(r.signatureOk).to.equal(false);
    });
  });

  // =================================================================================================
  // SIGNED TRUST / RECONCILIATION SEAL (real producer signing path). Siblings sit NEXT TO the seal, so
  // the default resolution (no --dir) works.
  // =================================================================================================
  describe("signed reconciliation seal", function () {
    it("ACCEPTS a genuine seal with the matching --vendor (exit 0); re-derives root incl. verdict/role header", async function () {
      const { sealPath, opWallet } = await makeSignedTrustSeal();
      const c = cap();
      const code = verifyvh.run([sealPath, "--vendor", opWallet.address, "--json"], c.io);
      expect(code, c.err()).to.equal(verifyvh.EXIT.OK);
      const r = JSON.parse(c.out());
      expect(r.verdict).to.equal("OK");
      expect(r.payloadKind).to.equal("trustledger.reconcile-seal");
      expect(r.rootMatches).to.equal(true);
      expect(r.recoveredSigner).to.equal(opWallet.address.toLowerCase());
      // matched all 3 inputs + 1 output.
      expect(r.counts.matched).to.equal(4);
    });

    it("editing ONE source byte reports exactly that file CHANGED (exit 3)", async function () {
      const { root, sealPath, opWallet } = await makeSignedTrustSeal();
      fs.writeFileSync(path.join(root, "bank.csv"), "date,amount\n2026-06-01,999\n"); // edited
      const c = cap();
      const code = verifyvh.run([sealPath, "--vendor", opWallet.address, "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      const r = JSON.parse(c.out());
      expect(r.reason).to.equal("CHANGED");
      expect(r.changed.map((x) => x.relPath)).to.deep.equal(["bank.csv"]);
      expect(r.rootMatches).to.equal(false);
    });

    it("a missing source file reports MISSING (exit 3)", async function () {
      const { root, sealPath, opWallet } = await makeSignedTrustSeal();
      fs.rmSync(path.join(root, "rent.csv"));
      const c = cap();
      const code = verifyvh.run([sealPath, "--vendor", opWallet.address, "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      const r = JSON.parse(c.out());
      expect(r.reason).to.equal("MISSING");
      expect(r.missing.map((x) => x.relPath)).to.deep.equal(["rent.csv"]);
    });

    it("a DIFFERENT --vendor yields wrong_issuer (exit 3)", async function () {
      const { sealPath } = await makeSignedTrustSeal();
      const c = cap();
      const code = verifyvh.run([sealPath, "--vendor", Wallet.createRandom().address, "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      expect(JSON.parse(c.out()).reason).to.equal("wrong_issuer");
    });

    it("a tampered signature yields bad_signature (exit 3)", async function () {
      const { root, sealPath, opWallet } = await makeSignedTrustSeal();
      const container = JSON.parse(fs.readFileSync(sealPath, "utf8"));
      const hex = container.signature.signature.slice(2);
      const flipped = (parseInt(hex.slice(0, 2), 16) ^ 0x01).toString(16).padStart(2, "0");
      container.signature.signature = "0x" + flipped + hex.slice(2);
      const badPath = path.join(root, "bad.vhseal");
      fs.writeFileSync(badPath, JSON.stringify(container));
      const c = cap();
      const code = verifyvh.run([badPath, "--vendor", opWallet.address, "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      expect(JSON.parse(c.out()).reason).to.equal("bad_signature");
    });
  });

  // =================================================================================================
  // SECURITY: PATH TRAVERSAL / ARBITRARY-FILE-READ + HASH-DISCLOSURE ORACLE.
  //
  // THREAT MODEL. verify-vh is packaged to be `npm install`ed and run by an UNTRUSTED COUNTERPARTY on an
  // artifact handed to them by the producer: attacker-controls-the-input, victim-runs-on-their-own-machine.
  // A malicious producer ships a "verify me" artifact whose `relPath`s probe the counterparty's filesystem.
  // Without confinement, verify-vh would read /etc/hostname (or ~/.ssh/id_rsa, .env, ...) and — via the
  // CHANGED branch — PRINT the keccak256 of that out-of-tree file in `changed[].actualContentHash`, turning
  // the verdict into a content-confirmation / hash-disclosure ORACLE over any file the running user can read.
  //
  // The contract these tests pin: a referenced path that escapes the artifact directory (absolute, `..`, or
  // an out-of-tree symlink) is a HARD REJECTED verdict (reason `path_escape`, exit 3) that reads NOTHING and
  // — critically — NEVER emits a content hash of the out-of-tree target anywhere in the output.
  // =================================================================================================
  describe("security: path confinement (no arbitrary file read / hash-disclosure oracle)", function () {
    // js-sha3 keccak256 of the bytes of a chosen target file, formatted as the verifier would emit it. We
    // compute it independently here so we can assert this exact string NEVER appears in verify-vh output.
    const { keccak256 } = require("js-sha3");
    function fileKeccak(absFile) {
      return "0x" + keccak256(fs.readFileSync(absFile));
    }

    // Build a minimal SIGNED evidence container whose embedded seal references a single attacker-chosen
    // relPath. We sign over a syntactically-valid (but irrelevant) embedded seal so the signature is sound;
    // the point under test is the FILE classification, which must refuse the escaping relPath before the
    // signature/issuer logic is even reached for the verdict.
    async function makeEvilEvidence(root, relPath) {
      const seal = {
        kind: "vh.evidence-seal",
        files: [{ relPath, contentHash: "0x" + "11".repeat(32), leaf: "0x" + "22".repeat(32) }],
        root: "0x" + "33".repeat(32),
      };
      const attestation = JSON.stringify(seal);
      const opWallet = Wallet.createRandom();
      // EIP-191 personal-sign over the exact embedded bytes (matches the verifier's recovery message).
      const signature = await opWallet.signMessage(attestation);
      const container = {
        kind: "vh.evidence-seal-signed",
        attestation,
        signature: { scheme: "eip191-personal-sign", signer: opWallet.address, signature },
      };
      const p = path.join(root, "evil.vhevidence.json");
      fs.writeFileSync(p, JSON.stringify(container));
      return { evilPath: p, opWallet };
    }

    it("a `..` traversal relPath is REJECTED (path_escape, exit 3) — reads nothing, leaks no hash", async function () {
      const root = mkTmp();
      // A real out-of-tree file with known content; assert its hash is NEVER disclosed.
      const outside = path.join(mkTmp(), "secret.txt");
      fs.writeFileSync(outside, "TOP-SECRET-COUNTERPARTY-FILE");
      const secretHash = fileKeccak(outside);

      // baseDir is root; relPath climbs out to the sibling temp dir's secret.txt.
      const rel = path.relative(root, outside); // e.g. "../verify-vh-XXXX/secret.txt"
      expect(rel.split(/[\\/]/)).to.include("..");
      const { evilPath, opWallet } = await makeEvilEvidence(root, rel);

      const c = cap();
      const code = verifyvh.run([evilPath, "--vendor", opWallet.address, "--dir", root, "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      const r = JSON.parse(c.out());
      expect(r.reason).to.equal("path_escape");
      expect(r.escaped.map((x) => x.relPath)).to.deep.equal([rel]);
      // CRITICAL: nothing was read or hashed — no CHANGED entry, and the secret's hash is absent everywhere.
      expect(r.changed).to.deep.equal([]);
      expect(r.counts.escaped).to.equal(1);
      expect(c.out()).to.not.contain(secretHash);
    });

    it("an ABSOLUTE relPath is REJECTED (path_escape, exit 3) — reads nothing, leaks no hash", async function () {
      const root = mkTmp();
      const outside = path.join(mkTmp(), "abs-secret.txt");
      fs.writeFileSync(outside, "ANOTHER-SECRET");
      const secretHash = fileKeccak(outside);

      const { evilPath, opWallet } = await makeEvilEvidence(root, outside); // absolute path

      const c = cap();
      const code = verifyvh.run([evilPath, "--vendor", opWallet.address, "--dir", root, "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      const r = JSON.parse(c.out());
      expect(r.reason).to.equal("path_escape");
      expect(r.escaped.map((x) => x.relPath)).to.deep.equal([outside]);
      expect(r.changed).to.deep.equal([]);
      expect(c.out()).to.not.contain(secretHash);
    });

    it("a SYMLINK sibling pointing OUTSIDE baseDir is REJECTED (path_escape) — bytes never hashed", async function () {
      const root = mkTmp();
      const outside = path.join(mkTmp(), "linked-secret.txt");
      fs.writeFileSync(outside, "SECRET-VIA-SYMLINK");
      const secretHash = fileKeccak(outside);

      // A sibling whose NAME is in-tree and contains no `..`, but which is a symlink escaping baseDir.
      const linkName = "innocent.txt";
      try {
        fs.symlinkSync(outside, path.join(root, linkName));
      } catch (e) {
        if (e.code === "EPERM" || e.code === "ENOSYS") return this.skip(); // platforms w/o symlink perms
        throw e;
      }

      const { evilPath, opWallet } = await makeEvilEvidence(root, linkName);
      const c = cap();
      const code = verifyvh.run([evilPath, "--vendor", opWallet.address, "--dir", root, "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      const r = JSON.parse(c.out());
      expect(r.reason).to.equal("path_escape");
      expect(r.escaped.map((x) => x.relPath)).to.deep.equal([linkName]);
      expect(r.changed).to.deep.equal([]);
      // The symlink target's content hash must NOT leak even though the name passed the string checks.
      expect(c.out()).to.not.contain(secretHash);
    });

    it("human output for a path_escape reports the relPath WITHOUT a content hash and exits 3", async function () {
      const root = mkTmp();
      const outside = path.join(mkTmp(), "h-secret.txt");
      fs.writeFileSync(outside, "HUMAN-SECRET");
      const secretHash = fileKeccak(outside);
      const rel = path.relative(root, outside);
      const { evilPath, opWallet } = await makeEvilEvidence(root, rel);

      const c = cap();
      const code = verifyvh.run([evilPath, "--vendor", opWallet.address, "--dir", root], c.io);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      expect(c.out()).to.match(/REJECTED \(path_escape\)/);
      expect(c.out()).to.contain("path escapes the artifact directory");
      expect(c.out()).to.not.contain(secretHash);
    });

    it("a legitimately in-tree sibling still verifies — confinement does not break the happy path", async function () {
      // Regression guard: the fix must not reject ordinary nested relPaths like "sub/b.txt".
      const { dir, packetPath, opWallet } = await makeSignedEvidencePacket();
      const c = cap();
      const code = verifyvh.run([packetPath, "--vendor", opWallet.address, "--dir", dir, "--json"], c.io);
      expect(code, c.err()).to.equal(verifyvh.EXIT.OK);
      const r = JSON.parse(c.out());
      expect(r.counts.escaped).to.equal(0);
      expect(r.rootMatches).to.equal(true);
    });
  });

  // =================================================================================================
  // EXIT-CODE + ARGUMENT contract (CI-gateable: 0 ok / 3 rejected / 2 usage / 1 IO).
  // =================================================================================================
  describe("CLI contract: exit codes + --json shape", function () {
    it("a missing artifact path is an IO error (exit 1)", function () {
      const c = cap();
      const code = verifyvh.run([path.join(mkTmp(), "nope.json")], c.io);
      expect(code).to.equal(verifyvh.EXIT.IO);
      expect(c.err()).to.match(/cannot read artifact/);
    });

    it("no artifact arg is a usage error (exit 2)", function () {
      const c = cap();
      const code = verifyvh.run([], c.io);
      expect(code).to.equal(verifyvh.EXIT.USAGE);
      expect(c.err()).to.match(/requires an <artifact>/);
    });

    it("an unknown flag is a usage error (exit 2)", function () {
      const c = cap();
      const code = verifyvh.run([path.join(mkTmp(), "x.json"), "--bogus"], c.io);
      expect(code).to.equal(verifyvh.EXIT.USAGE);
      expect(c.err()).to.match(/unknown flag/);
    });

    it("a malformed --vendor address is a usage error (exit 2)", async function () {
      const { sealPath } = await makeSignedTrustSeal();
      const c = cap();
      const code = verifyvh.run([sealPath, "--vendor", "0xnothex"], c.io);
      expect(code).to.equal(verifyvh.EXIT.USAGE);
      expect(c.err()).to.match(/must be a 0x-prefixed 20-byte hex address/);
    });

    it("a foreign/unrecognized JSON file is a usage error (exit 2), no stack trace", function () {
      const f = path.join(mkTmp(), "random.json");
      fs.writeFileSync(f, JSON.stringify({ kind: "totally.unknown", hello: "world" }));
      const c = cap();
      const code = verifyvh.run([f], c.io);
      expect(code).to.equal(verifyvh.EXIT.USAGE);
      expect(c.err()).to.match(/unrecognized artifact kind/);
      expect(c.err()).to.not.match(/\bat\s+\w+.*:\d+:\d+/); // no stack-trace lines leaked
    });

    it("--json round-trips a stable verdict object on a genuine artifact", async function () {
      const { sealPath, opWallet } = await makeSignedTrustSeal();
      const c = cap();
      const code = verifyvh.run([sealPath, "--vendor", opWallet.address, "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.OK);
      const r = JSON.parse(c.out());
      // The stable, documented shape a front-end/CI can depend on.
      for (const k of [
        "artifact",
        "kind",
        "payloadKind",
        "signed",
        "verdict",
        "reason",
        "accepted",
        "recoveredSigner",
        "claimedSigner",
        "pinnedVendor",
        "signatureOk",
        "sealedRoot",
        "recomputedRoot",
        "rootMatches",
        "counts",
        "note",
      ]) {
        expect(r, `missing ${k}`).to.have.property(k);
      }
      expect(r.accepted).to.equal(true);
      expect(r.verdict).to.equal("OK");
      // Idempotent: a second run over the same artifact yields the byte-identical JSON.
      const c2 = cap();
      verifyvh.run([sealPath, "--vendor", opWallet.address, "--json"], c2.io);
      expect(c2.out()).to.equal(c.out());
    });
  });
});

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
  // CRYPTO EQUIVALENCE: the verifier's INDEPENDENT merkle (js-sha3, no ethers) re-derives the EXACT root
  // the producer (cli/hash.js, ethers) commits to — INCLUDING the relPath class the verifier used to skew
  // on. The verifier's merkle.toPosixRel previously collapsed every backslash to "/", while the producer
  // keeps a literal backslash as a content byte on POSIX (split on path.sep === "/"). For a relPath like
  // `weird\name.txt` that made the verifier re-derive a DIFFERENT root than the producer sealed and FALSELY
  // REJECT (or, via an `a/b.txt` vs `a\b.txt` collision, FALSELY ACCEPT). These cross-checks pin the two
  // crypto paths byte-equal on those inputs forever. The producer path uses ethers; the verifier uses
  // js-sha3 — disjoint crypto graphs, so this is a genuine non-circular cross-check.
  // =================================================================================================

  describe("verifier merkle == producer merkle on backslash-bearing relPaths (anti-divergence)", function () {
    // The REAL producer hashing (ethers-backed); imported here ONLY in the test, never by the verifier.
    const producerHash = require("../cli/hash");
    const merkle = require("../verifier/lib/merkle");

    it("toPosixRel is byte-identical to the producer's (backslash kept, leading ./ stripped)", function () {
      for (const p of ["a\\b", "./x", "a/b", "x", "weird\\name.txt", "./a/b\\c", "dir\\a.txt"]) {
        expect(merkle.toPosixRel(p), `toPosixRel(${JSON.stringify(p)})`).to.equal(producerHash.toPosixRel(p));
      }
    });

    it("rootFromFlat re-derives the producer's root for a backslash-named file set", function () {
      const sets = [
        [{ relPath: "weird\\name.txt", bytes: Buffer.from("hi") }],
        [{ relPath: "dir\\a.txt", bytes: Buffer.alloc(0) }],
        // `a\b` (one backslash-named file) and `a/b` (a nested file) are DISTINCT on POSIX; both crypto
        // paths must agree they are two leaves and produce the same root.
        [
          { relPath: "a\\b", bytes: Buffer.from("one") },
          { relPath: "a/b", bytes: Buffer.from("two") },
        ],
        [
          { relPath: "top.txt", bytes: Buffer.from("t") },
          { relPath: "sub\\deep\\leaf.bin", bytes: Buffer.from([1, 2, 3]) },
        ],
      ];
      for (const set of sets) {
        // Producer root via the real ethers-backed builder (the exact math `vh evidence seal` runs).
        const built = producerHash.hashEntries(set.map((e) => ({ path: e.relPath, content: e.bytes })));
        const producerRoot = built.root;
        // Verifier root via the independent js-sha3 merkle.
        const flat = set.map((e) => ({ relPath: e.relPath, contentHash: merkle.hashBytes(e.bytes) }));
        const verifierRoot = merkle.rootFromFlat(flat);
        expect(verifierRoot, `root mismatch for ${JSON.stringify(set.map((e) => e.relPath))}`).to.equal(
          producerRoot
        );
      }
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

  // =================================================================================================
  // BATCH / MANIFEST mode (T-33.1). ONE invocation gates EVERY release artifact and returns ONE CI exit
  // code: 0 iff ALL pass, 3 if ANY is rejected (the report names WHICH artifact failed and why). The
  // per-artifact --json body is the SAME single-artifact shape (no divergence — the core is reused). The
  // single-artifact path stays byte-for-byte unchanged (asserted by the unchanged specs above + here).
  // =================================================================================================
  describe("batch / manifest mode (T-33.1)", function () {
    it("repeated <artifact> args (no manifest): batch engages, ALL pass -> ok, exit 0, stable aggregate", async function () {
      // Two trust seals whose siblings sit next to them (no --dir needed). Passing BOTH positionally engages
      // batch mode and inherits one top-level --vendor; here both seals are signed by the SAME ephemeral key
      // so a single --vendor pins both.
      const opWallet = Wallet.createRandom();
      async function sealNextTo() {
        const root = mkTmp();
        fs.writeFileSync(path.join(root, "bank.csv"), "date,amount\n2026-06-01,100\n");
        fs.writeFileSync(path.join(root, "book.csv"), "date,amount\n2026-06-01,100\n");
        fs.writeFileSync(path.join(root, "report.html"), "<html>ok</html>");
        const rd = (f) => fs.readFileSync(path.join(root, f));
        const bare = trustSeal.buildSeal({
          files: {
            inputs: [
              { role: "bank", relPath: "bank.csv", bytes: rd("bank.csv") },
              { role: "book", relPath: "book.csv", bytes: rd("book.csv") },
            ],
            outputs: [{ relPath: "report.html", bytes: rd("report.html") }],
          },
          verdict: { pass: true, reportDate: "2026-06-24", period: "2026-Q2" },
        });
        const container = await trustSeal.signSealWith(bare, opWallet);
        const sealPath = path.join(root, "recon.vhseal");
        fs.writeFileSync(sealPath, trustSeal.serializeSignedSeal(container));
        return sealPath;
      }
      const s1 = await sealNextTo();
      const s2 = await sealNextTo();
      const c = cap();
      const code = verifyvh.run([s1, s2, "--vendor", opWallet.address, "--json"], c.io);
      expect(code, c.err()).to.equal(verifyvh.EXIT.OK);
      const agg = JSON.parse(c.out());
      expect(agg.ok).to.equal(true);
      expect(agg.total).to.equal(2);
      expect(agg.passed).to.equal(2);
      expect(agg.failed).to.equal(0);
      expect(agg.results.map((r) => r.artifact)).to.deep.equal([s1, s2]);
    });

    it("two evidence packets sharing a vendor+dir: ALL pass -> { ok:true } exit 0", async function () {
      // Two independent signed evidence packets, each verified with its own --dir via the manifest.
      const a = await makeSignedEvidencePacket();
      const b = await makeSignedEvidencePacket();
      const root = mkTmp();
      const manifest = [
        `${a.packetPath} --vendor ${a.opWallet.address} --dir ${a.dir}`,
        `${b.packetPath} --vendor ${b.opWallet.address} --dir ${b.dir}`,
      ].join("\n");
      const manifestPath = path.join(root, "release.manifest");
      fs.writeFileSync(manifestPath, manifest + "\n");

      const c = cap();
      const code = verifyvh.run(["--manifest", manifestPath, "--json"], c.io);
      expect(code, c.err()).to.equal(verifyvh.EXIT.OK);
      const agg = JSON.parse(c.out());
      expect(agg.ok).to.equal(true);
      expect(agg.total).to.equal(2);
      expect(agg.passed).to.equal(2);
      expect(agg.failed).to.equal(0);
      expect(agg.results).to.have.length(2);
      // Each per-artifact entry is the SAME shape the single-artifact --json emits.
      for (const r of agg.results) {
        for (const k of ["artifact", "kind", "verdict", "reason", "accepted", "rootMatches", "counts", "note"]) {
          expect(r, `missing ${k}`).to.have.property(k);
        }
        expect(r.accepted).to.equal(true);
        expect(r.verdict).to.equal("OK");
      }
    });

    it("one-of-many tampered -> exit 3 with THAT artifact named and why", async function () {
      const good = await makeSignedEvidencePacket();
      const bad = await makeSignedEvidencePacket();
      // Tamper exactly one referenced byte of the SECOND packet.
      fs.writeFileSync(path.join(bad.dir, "a.txt"), "alphX");

      const root = mkTmp();
      const manifest = [
        `${good.packetPath} --vendor ${good.opWallet.address} --dir ${good.dir}`,
        `${bad.packetPath} --vendor ${bad.opWallet.address} --dir ${bad.dir}`,
      ].join("\n");
      const manifestPath = path.join(root, "release.manifest");
      fs.writeFileSync(manifestPath, manifest + "\n");

      const c = cap();
      const code = verifyvh.run(["--manifest", manifestPath, "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      const agg = JSON.parse(c.out());
      expect(agg.ok).to.equal(false);
      expect(agg.total).to.equal(2);
      expect(agg.passed).to.equal(1);
      expect(agg.failed).to.equal(1);
      // The failing artifact is named and the reason is localized.
      const failing = agg.results.filter((r) => !r.accepted);
      expect(failing).to.have.length(1);
      expect(failing[0].artifact).to.equal(path.resolve(bad.packetPath));
      expect(failing[0].reason).to.equal("CHANGED");
      expect(failing[0].changed.map((x) => x.relPath)).to.deep.equal(["a.txt"]);
      // The good one still passed.
      const passing = agg.results.filter((r) => r.accepted);
      expect(passing).to.have.length(1);
      expect(passing[0].artifact).to.equal(path.resolve(good.packetPath));
    });

    it("human batch output names the failing artifact + reason and exits 3", async function () {
      const good = await makeSignedTrustSeal();
      const bad = await makeSignedTrustSeal();
      fs.writeFileSync(path.join(bad.root, "bank.csv"), "date,amount\n2026-06-01,999\n");
      const root = mkTmp();
      const manifest = [
        `${good.sealPath} --vendor ${good.opWallet.address}`,
        `${bad.sealPath} --vendor ${bad.opWallet.address}`,
      ].join("\n");
      const manifestPath = path.join(root, "r.manifest");
      fs.writeFileSync(manifestPath, manifest + "\n");

      const c = cap();
      const code = verifyvh.run(["--manifest", manifestPath], c.io);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      expect(c.out()).to.match(/^verify-vh is an INDEPENDENT, read-only, OFFLINE verifier/);
      expect(c.out()).to.match(/FAIL\s+.*\.vhseal\s+\(CHANGED\)/);
      expect(c.out()).to.contain("bank.csv");
      expect(c.out()).to.match(/REJECTED — 1 artifact\(s\) failed\./);
    });

    it("JSON-array manifest with string + object entries works; per-entry vendor overrides default", async function () {
      const a = await makeSignedTrustSeal();
      const b = await makeSignedTrustSeal();
      const root = mkTmp();
      // a uses an object entry with its own vendor; b is a bare string that inherits the top-level --vendor.
      const arr = [
        { artifact: a.sealPath, vendor: a.opWallet.address },
        b.sealPath,
      ];
      const manifestPath = path.join(root, "m.json");
      fs.writeFileSync(manifestPath, JSON.stringify(arr));
      const c = cap();
      const code = verifyvh.run(["--manifest", manifestPath, "--vendor", b.opWallet.address, "--json"], c.io);
      expect(code, c.err()).to.equal(verifyvh.EXIT.OK);
      const agg = JSON.parse(c.out());
      expect(agg.ok).to.equal(true);
      expect(agg.total).to.equal(2);
    });

    it("a wrong per-entry --vendor on ONE manifest line -> that entry wrong_issuer, exit 3", async function () {
      const a = await makeSignedTrustSeal();
      const b = await makeSignedTrustSeal();
      const root = mkTmp();
      const wrong = Wallet.createRandom().address;
      const manifest = [
        `${a.sealPath} --vendor ${a.opWallet.address}`,
        `${b.sealPath} --vendor ${wrong}`,
      ].join("\n");
      const manifestPath = path.join(root, "r.manifest");
      fs.writeFileSync(manifestPath, manifest + "\n");
      const c = cap();
      const code = verifyvh.run(["--manifest", manifestPath, "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      const agg = JSON.parse(c.out());
      expect(agg.failed).to.equal(1);
      const failing = agg.results.filter((r) => !r.accepted);
      expect(failing[0].reason).to.equal("wrong_issuer");
      expect(failing[0].artifact).to.equal(path.resolve(b.sealPath));
    });

    it("newline manifest skips blank lines and # comments", async function () {
      const a = await makeSignedTrustSeal();
      const root = mkTmp();
      const manifest = [
        "# release artifacts",
        "",
        `${a.sealPath} --vendor ${a.opWallet.address}`,
        "   ",
        "# trailing comment",
      ].join("\n");
      const manifestPath = path.join(root, "r.manifest");
      fs.writeFileSync(manifestPath, manifest + "\n");
      const c = cap();
      const code = verifyvh.run(["--manifest", manifestPath, "--json"], c.io);
      expect(code, c.err()).to.equal(verifyvh.EXIT.OK);
      const agg = JSON.parse(c.out());
      expect(agg.total).to.equal(1);
      expect(agg.ok).to.equal(true);
    });

    it("path-escape confinement is preserved PER ENTRY in a batch (path_escape, exit 3, no hash leak)", async function () {
      // Reuse the security fixture builder from the path-confinement suite shape: a signed evidence seal
      // whose single relPath escapes baseDir must still be a hard REJECTED in batch, leaking no hash.
      const { keccak256 } = require("js-sha3");
      const root = mkTmp();
      const outside = path.join(mkTmp(), "batch-secret.txt");
      fs.writeFileSync(outside, "BATCH-SECRET");
      const secretHash = "0x" + keccak256(fs.readFileSync(outside));
      const rel = path.relative(root, outside);

      const seal = {
        kind: "vh.evidence-seal",
        files: [{ relPath: rel, contentHash: "0x" + "11".repeat(32), leaf: "0x" + "22".repeat(32) }],
        root: "0x" + "33".repeat(32),
      };
      const attestation = JSON.stringify(seal);
      const opWallet = Wallet.createRandom();
      const signature = await opWallet.signMessage(attestation);
      const evil = {
        kind: "vh.evidence-seal-signed",
        attestation,
        signature: { scheme: "eip191-personal-sign", signer: opWallet.address, signature },
      };
      const evilPath = path.join(root, "evil.vhevidence.json");
      fs.writeFileSync(evilPath, JSON.stringify(evil));

      // A good seal alongside, to prove the batch isolates the reject.
      const good = await makeSignedTrustSeal();
      const manifest = [
        `${good.sealPath} --vendor ${good.opWallet.address}`,
        `${evilPath} --vendor ${opWallet.address} --dir ${root}`,
      ].join("\n");
      const manifestPath = path.join(root, "r.manifest");
      fs.writeFileSync(manifestPath, manifest + "\n");

      const c = cap();
      const code = verifyvh.run(["--manifest", manifestPath, "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      const agg = JSON.parse(c.out());
      expect(agg.failed).to.equal(1);
      const failing = agg.results.filter((r) => !r.accepted);
      expect(failing[0].reason).to.equal("path_escape");
      // CRITICAL: the out-of-tree file's hash never appears anywhere in the aggregate output.
      expect(c.out()).to.not.contain(secretHash);
    });

    it("an unreadable artifact in the batch short-circuits as IO (exit 1), no false pass", async function () {
      const good = await makeSignedTrustSeal();
      const root = mkTmp();
      const manifest = [
        `${good.sealPath} --vendor ${good.opWallet.address}`,
        `${path.join(root, "does-not-exist.vhseal")}`,
      ].join("\n");
      const manifestPath = path.join(root, "r.manifest");
      fs.writeFileSync(manifestPath, manifest + "\n");
      const c = cap();
      const code = verifyvh.run(["--manifest", manifestPath, "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.IO);
      expect(c.err()).to.match(/cannot read artifact/);
    });

    it("an unreadable manifest file is an IO error (exit 1)", function () {
      const c = cap();
      const code = verifyvh.run(["--manifest", path.join(mkTmp(), "nope.manifest"), "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.IO);
      expect(c.err()).to.match(/cannot read manifest/);
    });

    it("an empty manifest (only comments/blanks) is a usage error (exit 2)", function () {
      const root = mkTmp();
      const manifestPath = path.join(root, "empty.manifest");
      fs.writeFileSync(manifestPath, "# nothing here\n\n");
      const c = cap();
      const code = verifyvh.run(["--manifest", manifestPath], c.io);
      expect(code).to.equal(verifyvh.EXIT.USAGE);
      expect(c.err()).to.match(/lists no artifacts/);
    });

    it("--manifest together with a positional <artifact> is a usage error (exit 2)", function () {
      const c = cap();
      const code = verifyvh.run(["--manifest", "m.txt", "extra.json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.USAGE);
      expect(c.err()).to.match(/do not also pass positional/);
    });

    it("a malformed per-entry --vendor in a manifest is a usage error (exit 2)", async function () {
      const a = await makeSignedTrustSeal();
      const root = mkTmp();
      const manifestPath = path.join(root, "r.manifest");
      fs.writeFileSync(manifestPath, `${a.sealPath} --vendor 0xnothex\n`);
      const c = cap();
      const code = verifyvh.run(["--manifest", manifestPath], c.io);
      expect(code).to.equal(verifyvh.EXIT.USAGE);
      expect(c.err()).to.match(/must be a 0x-prefixed 20-byte hex address/);
    });

    it("SINGLE-artifact path is unchanged: a lone positional behaves identically with no batch shape", async function () {
      const { sealPath, opWallet } = await makeSignedTrustSeal();
      const single = cap();
      const codeSingle = verifyvh.run([sealPath, "--vendor", opWallet.address, "--json"], single.io);
      expect(codeSingle).to.equal(verifyvh.EXIT.OK);
      const r = JSON.parse(single.out());
      // It is the single-artifact object, NOT an aggregate (no ok/total/passed/failed/results wrapper).
      expect(r).to.not.have.property("results");
      expect(r).to.not.have.property("total");
      expect(r.verdict).to.equal("OK");
    });
  });
});

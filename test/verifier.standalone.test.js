"use strict";

// test/verifier.standalone.test.js — T-35.2: PROVE the single-file, zero-install standalone verifier.
//
// WHY THIS TEST EXISTS
//   `verifier/dist/verify-vh-standalone.js` is the FUNNEL deliverable: a counterparty who received ONE
//   sealed packet saves THIS ONE FILE (no clone, no `npm install`, no node_modules, no package.json) and
//   runs it with `node`. docs make that promise in prose; this suite makes it TRUE in code so the prose can
//   never silently drift. Four load-bearing properties (the task acceptance):
//
//   (1) DETERMINISTIC + ANTI-ROT — building the bundle twice yields BYTE-IDENTICAL output, AND the committed
//       dist file equals a fresh rebuild byte-for-byte (a stale committed bundle FAILS here, i.e. in CI).
//   (2) ZERO external deps — the file requires NOTHING outside Node core: a grep finds no `require('js-sha3')`,
//       no `require('./lib/...')`, no `../`, no bare third-party name. Copied ALONE into an EMPTY temp dir
//       (no node_modules, no package.json) it runs `node verify-vh-standalone.js <good>` -> exit 0 and
//       `<tampered>` -> exit 3, in a CHILD PROCESS whose require() cannot reach this repo's node_modules.
//   (3) SAME VERDICTS — across a battery of artifacts (signed/unsigned evidence seal, reconciliation seal,
//       dataset attestation, proof bundle; ACCEPT / CHANGED / MISSING / bad_signature / wrong_issuer;
//       batch/manifest) the standalone produces the EXACT same verdict text + exit code as the in-tree
//       `verifier/verify-vh.js`.
//   (4) NO NETWORK — the standalone, run with the EPIC-31 network-poison guard preloaded, opens no socket
//       (clean exit over a real signed fixture). The in-tree verifier is UNCHANGED (asserted).
//
// All keys are EPHEMERAL Wallet.createRandom() (TEST-ONLY — never a real key / real funds). Every write
// lands under a throwaway temp dir cleaned in afterEach; the working tree (cwd) is asserted untouched.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const { Wallet } = require("ethers");

// The REAL producers (their signing paths are exactly what the CLI uses) — for genuine signed fixtures.
const evidence = require("../cli/evidence");
const trustSeal = require("../trustledger/seal");

// The in-tree verifier (the ORACLE the standalone must match) and the bundler under test.
const verifyvh = require("../verifier/verify-vh");
const builder = require("../verifier/build-standalone");
// The verifier's OWN merkle lib — the source of truth for hashes when we hand-build dataset/proof fixtures.
const merkle = require("../verifier/lib/merkle");

const ISSUED = "2026-06-01T00:00:00.000Z";
const EXPIRES = "2027-06-01T00:00:00.000Z";
const NOW = new Date("2026-06-24T00:00:00.000Z");

const STANDALONE_PATH = path.resolve(__dirname, "..", "verifier", "dist", "verify-vh-standalone.js");
const SHA256_PATH = STANDALONE_PATH + ".sha256";
const INTREE_PATH = path.resolve(__dirname, "..", "verifier", "verify-vh.js");

// The three docs that MUST surface the zero-install path and name the standalone file (T-35.3).
const DOC_PATHS = {
  "docs/INDEPENDENT-VERIFICATION.md": path.resolve(__dirname, "..", "docs", "INDEPENDENT-VERIFICATION.md"),
  "verifier/README.md": path.resolve(__dirname, "..", "verifier", "README.md"),
  "docs/PILOT.md": path.resolve(__dirname, "..", "docs", "PILOT.md"),
};

describe("verifier standalone: single-file, zero-install bundle (T-35.2)", function () {
  // Bundling + child spawns can be a touch slower than a unit test; give generous headroom.
  this.timeout(60000);

  let tmpDirs;
  let cwdBefore;

  beforeEach(function () {
    tmpDirs = [];
    cwdBefore = fs.readdirSync(process.cwd()).sort();
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    // FILESYSTEM HYGIENE: nothing the producers / the bundler / the verifier did leaked into the working
    // tree. (The bundler writes to verifier/dist/ which already exists & is committed — not cwd.)
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });

  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-standalone-"));
    tmpDirs.push(d);
    return d;
  }

  function cap() {
    let out = "";
    let err = "";
    return {
      io: { write: (s) => (out += s), writeErr: (s) => (err += s) },
      out: () => out,
      err: () => err,
    };
  }

  // Run the STANDALONE bundle in a CHILD PROCESS. `cwd`/`env` are controlled so we can prove it needs no
  // node_modules. Returns { status, stdout, stderr }.
  function runStandalone(bundlePath, args, opts = {}) {
    const res = spawnSync(process.execPath, [bundlePath, ...args], {
      encoding: "utf8",
      cwd: opts.cwd || path.dirname(bundlePath),
      // A clean-ish env: keep PATH but DROP NODE_PATH so the child cannot pull this repo's modules by env.
      env: { ...process.env, NODE_PATH: "" },
      ...opts.spawn,
    });
    return res;
  }

  // Run the in-tree verifier in-process (the ORACLE). Returns { code, out, err }.
  function runInTree(args) {
    const c = cap();
    const code = verifyvh.run(args, c.io);
    return { code, out: c.out(), err: c.err() };
  }

  // ============================================================================================
  // FIXTURE BUILDERS — genuine artifacts spanning every kind/verdict the task names.
  // ============================================================================================

  // A genuine SIGNED evidence packet via the REAL producer CLI path. Returns { root, dir, packetPath, opWallet }.
  async function makeSignedEvidencePacket() {
    const root = mkTmp();
    const dir = path.join(root, "data");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "alpha");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "b.txt"), "beta");
    fs.writeFileSync(path.join(dir, "c.bin"), Buffer.from([0, 1, 2, 255]));

    const vendorWallet = Wallet.createRandom();
    const license = await evidence.buildLicense(
      {
        licenseId: "EV-STD-1",
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

    const opWallet = Wallet.createRandom();
    const keyEnv = "VFY_STD_OP_KEY_" + Math.random().toString(36).slice(2);
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
    return { root, dir, packetPath, opWallet };
  }

  // A genuine UNSIGNED evidence seal, hand-built with the verifier's own merkle lib (root is authentic).
  // Siblings sit next to the seal. Returns { root, dir, sealPath }.
  function makeUnsignedEvidenceSeal() {
    const root = mkTmp();
    const dir = path.join(root, "data");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "x.txt"), "ex-content");
    fs.writeFileSync(path.join(dir, "y.txt"), "why-content");
    const files = ["x.txt", "y.txt"].map((rel) => {
      const contentHash = merkle.hashBytes(fs.readFileSync(path.join(dir, rel)));
      return { relPath: rel, contentHash, leaf: merkle.pathLeaf(rel, contentHash) };
    });
    const treeRoot = merkle.rootFromFlat(files.map((f) => ({ relPath: f.relPath, contentHash: f.contentHash })));
    const seal = { kind: "vh.evidence-seal", files, root: treeRoot };
    const sealPath = path.join(dir, "unsigned.vhevidence.json");
    fs.writeFileSync(sealPath, JSON.stringify(seal, null, 2));
    return { root, dir, sealPath };
  }

  // A genuine SIGNED reconciliation/trust seal via the REAL producer signing path. Siblings sit next to it.
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

  // A SIGNED dataset attestation. The dataset attestation is identity-only (root + fileCount + manifestDigest)
  // so we build a syntactically genuine envelope and sign over its EXACT embedded bytes with an ephemeral key
  // (the same EIP-191 personal-sign the producer + verifier use). Returns { root, attPath, opWallet }.
  async function makeSignedDatasetAttestation() {
    const root = mkTmp();
    const att = {
      kind: "verifyhash.dataset-attestation",
      root: "0x" + "ab".repeat(32),
      fileCount: 7,
      manifestDigest: "0x" + "cd".repeat(32),
    };
    const attestation = JSON.stringify(att);
    const opWallet = Wallet.createRandom();
    const signature = await opWallet.signMessage(attestation);
    const container = {
      kind: "verifyhash.dataset-attestation-signed",
      attestation,
      signature: { scheme: "eip191-personal-sign", signer: opWallet.address, signature },
    };
    const attPath = path.join(root, "dataset.vhattest.json");
    fs.writeFileSync(attPath, JSON.stringify(container, null, 2));
    return { root, attPath, opWallet };
  }

  // A genuine PROOF bundle: build a small sorted-leaf tree from N files using the verifier's merkle lib, then
  // hand-assemble the { root, leaf, contentHash, relPath, proof[] } for ONE leaf so the offline fold folds to
  // the root. Returns { root, proofPath }.
  function makeProofBundle() {
    const root = mkTmp();
    // Three distinct files -> three path-bound leaves.
    const entries = [
      { relPath: "one.txt", bytes: Buffer.from("one") },
      { relPath: "two.txt", bytes: Buffer.from("two") },
      { relPath: "three.txt", bytes: Buffer.from("three") },
    ].map((e) => {
      const contentHash = merkle.hashBytes(e.bytes);
      return { relPath: e.relPath, contentHash, leaf: merkle.pathLeaf(e.relPath, contentHash) };
    });
    // Sort leaves ascending (the tree convention), tag each with leafHash, fold pairwise (dup the odd node),
    // recording the sibling at each level for the TARGET leaf so we can emit a valid proof.
    const target = entries[0];
    const sortedLeaves = entries.map((e) => e.leaf).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let layer = sortedLeaves.map((leaf) => ({ node: merkle.leafHash(leaf), isTarget: leaf === target.leaf }));
    const proof = [];
    while (layer.length > 1) {
      const next = [];
      for (let i = 0; i < layer.length; i += 2) {
        const left = layer[i];
        const right = i + 1 < layer.length ? layer[i + 1] : layer[i];
        if (left.isTarget) proof.push(right.node);
        else if (right.isTarget && right !== left) proof.push(left.node);
        next.push({ node: merkle.nodeHash(left.node, right.node), isTarget: left.isTarget || right.isTarget });
      }
      layer = next;
    }
    const treeRoot = layer[0].node;
    const bundle = {
      kind: "verifyhash.merkle-proof",
      root: treeRoot,
      leaf: target.leaf,
      contentHash: target.contentHash,
      relPath: target.relPath,
      proof,
    };
    const proofPath = path.join(root, "membership.vhproof.json");
    fs.writeFileSync(proofPath, JSON.stringify(bundle, null, 2));
    return { root, proofPath };
  }

  // ============================================================================================
  // (1) DETERMINISTIC BUILD + ANTI-ROT.
  // ============================================================================================
  describe("(1) deterministic build + anti-rot guard", function () {
    it("two fresh builds are BYTE-IDENTICAL (no timestamp / randomness / fs-order dependence)", function () {
      const a = builder.buildBundle();
      const b = builder.buildBundle();
      expect(a).to.equal(b);
      expect(Buffer.byteLength(a)).to.be.greaterThan(1000);
    });

    it("the COMMITTED dist file matches a fresh rebuild byte-for-byte (a stale bundle FAILS here)", function () {
      const fresh = builder.buildBundle();
      const committed = fs.readFileSync(STANDALONE_PATH, "utf8");
      expect(
        committed,
        "verifier/dist/verify-vh-standalone.js is STALE — re-run `node verifier/build-standalone.js` and commit it"
      ).to.equal(fresh);
    });

    it("rebuilding into a TEMP dir reproduces the committed bytes (the build reads only committed source)", function () {
      // Sanity that the bundle is a pure function of source: write to a scratch path and compare.
      const tmp = path.join(mkTmp(), "rebuild.js");
      fs.writeFileSync(tmp, builder.buildBundle());
      expect(fs.readFileSync(tmp)).to.deep.equal(fs.readFileSync(STANDALONE_PATH));
    });
  });

  // ============================================================================================
  // (2) ZERO external deps + runs from an EMPTY dir with no node_modules.
  // ============================================================================================
  describe("(2) zero external dependencies; runs from an EMPTY dir", function () {
    const SRC = () => fs.readFileSync(STANDALONE_PATH, "utf8");

    it("contains NO require('js-sha3'), no relative './lib/' or '../' require, no bare third-party require", function () {
      const src = SRC();
      // Every REAL require("…") specifier in the emitted file must be a Node-core module (fs/path) — nothing
      // else. We match a `require(` that is NOT preceded by an identifier char so the bundle's OWN internal
      // `__require("<module-id>")` shim calls (the inlined CommonJS loader) are excluded — they are not Node
      // requires and resolve only against the bundle's own embedded module table.
      const specs = [...src.matchAll(/(^|[^A-Za-z0-9_$])require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[2]);
      expect(specs.length, "the bundle does call require() for Node core").to.be.greaterThan(0);
      // `crypto` is Node CORE (no node_modules, no install) — the embedded `--self-attest` boot code hashes
      // the file's own bytes, so it is allowed alongside fs/path. `os` is Node CORE too — the T-55.2 `demo`
      // quickstart uses `os.tmpdir()` for its throwaway working dir. The zero-dependency guarantee (runs from
      // an empty dir, no `npm install`) is fully preserved; the proof is the empty-dir child-process run below.
      for (const s of specs) {
        expect(
          ["fs", "path", "crypto", "os", "node:fs", "node:path", "node:crypto", "node:os"],
          `forbidden require(${JSON.stringify(s)})`
        ).to.include(s);
      }
      // Belt-and-suspenders explicit checks the task spells out.
      expect(src, "no require('js-sha3')").to.not.match(/require\(\s*["']js-sha3/);
      expect(src, "no require('./lib/...')").to.not.match(/require\(\s*["']\.\/lib/);
      expect(src, "no '../' in any require").to.not.match(/require\(\s*["']\.\./);
    });

    it("copied ALONE into an empty temp dir (no node_modules/package.json): good -> exit 0, tampered -> exit 3", function () {
      const { dir, sealPath } = makeUnsignedEvidenceSeal();

      // An EMPTY directory: ONLY the standalone file. No package.json, no node_modules.
      const empty = mkTmp();
      const bundle = path.join(empty, "verify-vh-standalone.js");
      fs.copyFileSync(STANDALONE_PATH, bundle);
      expect(fs.readdirSync(empty).sort()).to.deep.equal(["verify-vh-standalone.js"]);

      // GOOD packet -> exit 0. cwd is the empty dir; --dir points at the data tree; NODE_PATH is cleared so
      // the child cannot reach this repo's node_modules even by accident.
      const good = runStandalone(bundle, [sealPath, "--dir", dir], { cwd: empty });
      expect(good.error, "no spawn error (good)").to.equal(undefined);
      expect(good.status, `good exit 0 (stderr: ${good.stderr})`).to.equal(0);
      expect(good.stdout).to.match(/OK — the artifact verifies\./);

      // TAMPER one referenced byte -> exit 3.
      fs.writeFileSync(path.join(dir, "x.txt"), "ex-contentX");
      const bad = runStandalone(bundle, [sealPath, "--dir", dir], { cwd: empty });
      expect(bad.status, `tampered exit 3 (stderr: ${bad.stderr})`).to.equal(3);
      expect(bad.stdout).to.match(/REJECTED \(CHANGED\)/);
    });

    it("the empty-dir run does not create node_modules and writes nothing in the empty dir", function () {
      const { dir, sealPath } = makeUnsignedEvidenceSeal();
      const empty = mkTmp();
      const bundle = path.join(empty, "verify-vh-standalone.js");
      fs.copyFileSync(STANDALONE_PATH, bundle);
      runStandalone(bundle, [sealPath, "--dir", dir], { cwd: empty });
      // READ-ONLY: the only thing in the dir is still the bundle itself.
      expect(fs.readdirSync(empty).sort()).to.deep.equal(["verify-vh-standalone.js"]);
    });
  });

  // ============================================================================================
  // (3) SAME VERDICTS as the in-tree verifier across the full battery.
  // ============================================================================================
  describe("(3) standalone == in-tree verifier (verdict text + exit code) across the battery", function () {
    // For one set of CLI args, assert the standalone's (stdout, exit) equals the in-tree's (out, code).
    // The standalone runs in a child; the in-tree runs in-process — both over the SAME artifact + args.
    function assertSame(args, label) {
      const oracle = runInTree(args);
      const sa = runStandalone(STANDALONE_PATH, args);
      expect(sa.error, `${label}: no spawn error`).to.equal(undefined);
      expect(sa.status, `${label}: exit code matches (in-tree ${oracle.code}, stderr: ${sa.stderr})`).to.equal(
        oracle.code
      );
      // The standalone's stdout must equal the in-tree's stdout byte-for-byte. (The in-tree CLI writes the
      // SAME human/JSON body; only the boot wrapper differs, which writes nothing extra to stdout.)
      expect(sa.stdout, `${label}: stdout matches the in-tree verifier`).to.equal(oracle.out);
    }

    it("signed evidence packet — ACCEPT (matching --vendor)", async function () {
      const { dir, packetPath, opWallet } = await makeSignedEvidencePacket();
      assertSame([packetPath, "--vendor", opWallet.address, "--dir", dir], "evidence ACCEPT");
      assertSame([packetPath, "--vendor", opWallet.address, "--dir", dir, "--json"], "evidence ACCEPT json");
    });

    it("signed evidence packet — CHANGED (one referenced byte edited)", async function () {
      const { dir, packetPath, opWallet } = await makeSignedEvidencePacket();
      fs.writeFileSync(path.join(dir, "a.txt"), "alphX");
      assertSame([packetPath, "--vendor", opWallet.address, "--dir", dir], "evidence CHANGED");
      assertSame([packetPath, "--vendor", opWallet.address, "--dir", dir, "--json"], "evidence CHANGED json");
    });

    it("signed evidence packet — wrong_issuer (different --vendor)", async function () {
      const { dir, packetPath } = await makeSignedEvidencePacket();
      const other = Wallet.createRandom().address;
      assertSame([packetPath, "--vendor", other, "--dir", dir], "evidence wrong_issuer");
      assertSame([packetPath, "--vendor", other, "--dir", dir, "--json"], "evidence wrong_issuer json");
    });

    it("signed evidence packet — bad_signature (tampered signature)", async function () {
      const { root, dir, packetPath, opWallet } = await makeSignedEvidencePacket();
      const container = JSON.parse(fs.readFileSync(packetPath, "utf8"));
      const hex = container.signature.signature.slice(2);
      const flipped = (parseInt(hex.slice(0, 2), 16) ^ 0x01).toString(16).padStart(2, "0");
      container.signature.signature = "0x" + flipped + hex.slice(2);
      const badPath = path.join(root, "bad.vhevidence.json");
      fs.writeFileSync(badPath, JSON.stringify(container));
      assertSame([badPath, "--vendor", opWallet.address, "--dir", dir], "evidence bad_signature");
      assertSame([badPath, "--vendor", opWallet.address, "--dir", dir, "--json"], "evidence bad_signature json");
    });

    it("UNSIGNED evidence seal — ACCEPT and CHANGED", function () {
      const { dir, sealPath } = makeUnsignedEvidenceSeal();
      assertSame([sealPath, "--dir", dir], "unsigned evidence ACCEPT");
      assertSame([sealPath, "--dir", dir, "--json"], "unsigned evidence ACCEPT json");
      fs.writeFileSync(path.join(dir, "y.txt"), "why-content-EDITED");
      assertSame([sealPath, "--dir", dir], "unsigned evidence CHANGED");
    });

    it("signed reconciliation seal — ACCEPT, CHANGED, MISSING, wrong_issuer, bad_signature", async function () {
      const accept = await makeSignedTrustSeal();
      assertSame([accept.sealPath, "--vendor", accept.opWallet.address], "trust ACCEPT");
      assertSame([accept.sealPath, "--vendor", accept.opWallet.address, "--json"], "trust ACCEPT json");

      const changed = await makeSignedTrustSeal();
      fs.writeFileSync(path.join(changed.root, "bank.csv"), "date,amount\n2026-06-01,999\n");
      assertSame([changed.sealPath, "--vendor", changed.opWallet.address], "trust CHANGED");

      const missing = await makeSignedTrustSeal();
      fs.rmSync(path.join(missing.root, "rent.csv"));
      assertSame([missing.sealPath, "--vendor", missing.opWallet.address], "trust MISSING");

      const wrong = await makeSignedTrustSeal();
      assertSame([wrong.sealPath, "--vendor", Wallet.createRandom().address], "trust wrong_issuer");

      const badsig = await makeSignedTrustSeal();
      const container = JSON.parse(fs.readFileSync(badsig.sealPath, "utf8"));
      const hex = container.signature.signature.slice(2);
      const flipped = (parseInt(hex.slice(0, 2), 16) ^ 0x01).toString(16).padStart(2, "0");
      container.signature.signature = "0x" + flipped + hex.slice(2);
      const badPath = path.join(badsig.root, "bad.vhseal");
      fs.writeFileSync(badPath, JSON.stringify(container));
      assertSame([badPath, "--vendor", badsig.opWallet.address], "trust bad_signature");
    });

    it("signed dataset attestation — ACCEPT, wrong_issuer, bad_signature", async function () {
      const accept = await makeSignedDatasetAttestation();
      assertSame([accept.attPath, "--vendor", accept.opWallet.address], "dataset ACCEPT");
      assertSame([accept.attPath, "--vendor", accept.opWallet.address, "--json"], "dataset ACCEPT json");

      const wrong = await makeSignedDatasetAttestation();
      assertSame([wrong.attPath, "--vendor", Wallet.createRandom().address], "dataset wrong_issuer");

      const badsig = await makeSignedDatasetAttestation();
      const container = JSON.parse(fs.readFileSync(badsig.attPath, "utf8"));
      const hex = container.signature.signature.slice(2);
      const flipped = (parseInt(hex.slice(0, 2), 16) ^ 0x01).toString(16).padStart(2, "0");
      container.signature.signature = "0x" + flipped + hex.slice(2);
      fs.writeFileSync(badsig.attPath, JSON.stringify(container, null, 2));
      assertSame([badsig.attPath, "--vendor", badsig.opWallet.address], "dataset bad_signature");
    });

    it("proof bundle — ACCEPT (folds to root) and CHANGED (forged contentHash)", function () {
      const ok = makeProofBundle();
      assertSame([ok.proofPath], "proof ACCEPT");
      assertSame([ok.proofPath, "--json"], "proof ACCEPT json");

      // Forge the contentHash so the re-derived leaf no longer matches -> CHANGED/REJECTED.
      const forged = makeProofBundle();
      const bundle = JSON.parse(fs.readFileSync(forged.proofPath, "utf8"));
      bundle.contentHash = "0x" + "00".repeat(32);
      fs.writeFileSync(forged.proofPath, JSON.stringify(bundle, null, 2));
      assertSame([forged.proofPath], "proof CHANGED");
    });

    it("BATCH (repeated positionals) — all pass; and MANIFEST mixed pass/fail", async function () {
      // Batch via repeated positionals: two trust seals signed by the SAME key, both pass.
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
      assertSame([s1, s2, "--vendor", opWallet.address], "batch positionals all-pass");
      assertSame([s1, s2, "--vendor", opWallet.address, "--json"], "batch positionals all-pass json");

      // Manifest with one good + one tampered evidence packet -> aggregate REJECTED, names the failure.
      const good = await makeSignedEvidencePacket();
      const bad = await makeSignedEvidencePacket();
      fs.writeFileSync(path.join(bad.dir, "a.txt"), "alphX");
      const mroot = mkTmp();
      const manifest = [
        `${good.packetPath} --vendor ${good.opWallet.address} --dir ${good.dir}`,
        `${bad.packetPath} --vendor ${bad.opWallet.address} --dir ${bad.dir}`,
      ].join("\n");
      const manifestPath = path.join(mroot, "release.manifest");
      fs.writeFileSync(manifestPath, manifest + "\n");
      assertSame(["--manifest", manifestPath], "manifest mixed pass/fail");
      assertSame(["--manifest", manifestPath, "--json"], "manifest mixed pass/fail json");
    });

    it("usage + IO errors match (exit 2 / exit 1, same stderr-bearing contract)", function () {
      // No artifact -> usage (exit 2). stderr is written, stdout empty; compare exit + stdout.
      assertSame([], "no artifact (usage)");
      // Unreadable artifact -> IO (exit 1).
      const missing = path.join(mkTmp(), "nope.json");
      assertSame([missing], "missing artifact (IO)");
      // Unrecognized JSON -> usage (exit 2).
      const foreign = path.join(mkTmp(), "foreign.json");
      fs.writeFileSync(foreign, JSON.stringify({ kind: "totally.unknown", hi: 1 }));
      assertSame([foreign], "foreign kind (usage)");
    });

    it("path-escape confinement matches: hard REJECTED, no out-of-tree hash disclosed (parity)", async function () {
      const root = mkTmp();
      const outside = path.join(mkTmp(), "secret.txt");
      fs.writeFileSync(outside, "TOP-SECRET");
      const rel = path.relative(root, outside);
      const seal = {
        kind: "vh.evidence-seal",
        files: [{ relPath: rel, contentHash: "0x" + "11".repeat(32), leaf: "0x" + "22".repeat(32) }],
        root: "0x" + "33".repeat(32),
      };
      const attestation = JSON.stringify(seal);
      const opWallet = Wallet.createRandom();
      const signature = await opWallet.signMessage(attestation);
      const container = {
        kind: "vh.evidence-seal-signed",
        attestation,
        signature: { scheme: "eip191-personal-sign", signer: opWallet.address, signature },
      };
      const evilPath = path.join(root, "evil.vhevidence.json");
      fs.writeFileSync(evilPath, JSON.stringify(container));
      assertSame([evilPath, "--vendor", opWallet.address, "--dir", root], "path_escape");
      assertSame([evilPath, "--vendor", opWallet.address, "--dir", root, "--json"], "path_escape json");
    });
  });

  // ============================================================================================
  // (4) NO NETWORK — the standalone, with the EPIC-31 network-poison guard preloaded, opens no socket.
  //     Plus: the in-tree verifier source is UNCHANGED by this task.
  // ============================================================================================
  describe("(4) no network handle (EPIC-31 poison guard) + in-tree verifier unchanged", function () {
    // The SAME poison-guard the EPIC-31 isolation test uses: trap every OUTBOUND network primitive so any
    // attempt to open a connection / do a DNS lookup / fire an http(s) request throws synchronously. A clean
    // exit over a real signed fixture PROVES the standalone opened no network handle.
    function writeNetworkGuard(dir) {
      const guard = path.join(dir, "net-guard.cjs");
      fs.writeFileSync(
        guard,
        [
          "'use strict';",
          "const TRIP = (api) => { throw new Error('NETWORK ACCESS ATTEMPTED: ' + api); };",
          "for (const mod of ['net','tls','http','https','http2']) {",
          "  let m; try { m = require(mod); } catch (_) { continue; }",
          "  for (const fn of ['connect','createConnection','request','get']) {",
          "    if (typeof m[fn] === 'function') {",
          "      const name = mod + '.' + fn;",
          "      Object.defineProperty(m, fn, { configurable: true, writable: true, value: function () { TRIP(name); } });",
          "    }",
          "  }",
          "}",
          "const dns = require('dns');",
          "for (const fn of ['lookup','resolve','resolve4','resolve6','lookupService']) {",
          "  if (typeof dns[fn] === 'function') dns[fn] = function () { TRIP('dns.' + fn); };",
          "  if (dns.promises && typeof dns.promises[fn] === 'function') dns.promises[fn] = function () { return Promise.reject(new Error('NETWORK ACCESS ATTEMPTED: dns.promises.' + fn)); };",
          "}",
          "",
        ].join("\n")
      );
      return guard;
    }

    it("standalone accepts a real signed packet with the network POISONED (exit 0, no socket opened)", async function () {
      const { dir, packetPath, opWallet } = await makeSignedEvidencePacket();
      const guard = writeNetworkGuard(path.dirname(packetPath));
      const res = spawnSync(
        process.execPath,
        ["--require", guard, STANDALONE_PATH, packetPath, "--vendor", opWallet.address, "--dir", dir, "--json"],
        { encoding: "utf8", env: { ...process.env, NODE_PATH: "" } }
      );
      expect(res.error, "no spawn error").to.equal(undefined);
      const combined = (res.stdout || "") + (res.stderr || "");
      expect(combined, "guard never tripped").to.not.match(/NETWORK ACCESS ATTEMPTED/);
      expect(res.status, `exit 0 (out: ${combined})`).to.equal(0);
      const verdict = JSON.parse(res.stdout);
      expect(verdict.accepted).to.equal(true);
      expect(verdict.verdict).to.equal("OK");
    });

    it("the poison guard is not a no-op (a throwaway script that DOES touch the network crashes)", function () {
      const dir = mkTmp();
      const guard = writeNetworkGuard(dir);
      const offender = path.join(dir, "offender.cjs");
      fs.writeFileSync(offender, "require('http').get('http://127.0.0.1:9/');\n");
      const res = spawnSync(process.execPath, ["--require", guard, offender], { encoding: "utf8" });
      expect(res.status, "offender crashed").to.not.equal(0);
      expect((res.stdout || "") + (res.stderr || "")).to.match(/NETWORK ACCESS ATTEMPTED/);
    });

    it("the in-tree verifier source (verifier/verify-vh.js) requires only ./lib + Node core", function () {
      // The in-tree verifier requires ONLY its own ./lib/* siblings + Node core (fs/path) — never ethers/
      // hardhat or a cli/ back-edge. The bundler is additive and inlines exactly these. T-51.4 adds the
      // stack-free ./lib/revocation reader to the graph (still pure-JS, still no producer stack); T-70.4
      // adds Node-core `crypto` (sha256 for the anchored-receipt attestation digest legs — still
      // zero-install, no node_modules).
      const src = fs.readFileSync(INTREE_PATH, "utf8");
      const specs = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
      // De-dupe: `os` (T-55.2 demo `os.tmpdir()`) is a second Node-core sibling alongside fs/path.
      expect([...new Set(specs)].sort()).to.deep.equal(
        ["./lib/canonical", "./lib/merkle", "./lib/revocation", "./lib/secp256k1-recover", "crypto", "fs", "os", "path"].sort()
      );
    });
  });

  // ============================================================================================
  // (5) PUBLISHED CHECKSUM + ZERO-INSTALL DOC PATH (T-35.3).
  //   - The committed `.sha256` sidecar equals the SHA-256 of the committed bundle (and the build's own
  //     deterministic sidecar text), in the standard `sha256sum -c`-checkable line format.
  //   - Each of the three docs documents the zero-install path FIRST, names `verify-vh-standalone.js`,
  //     and RESTATES the honest scope boundary (tamper-evidence + signer-pin, NOT a trusted "sealed at T"
  //     without P-3) so the easier path never overclaims.
  // ============================================================================================
  describe("(5) published checksum + zero-install doc path (T-35.3)", function () {
    function sha256Hex(buf) {
      return crypto.createHash("sha256").update(buf).digest("hex");
    }

    it("the committed `.sha256` sidecar EQUALS the SHA-256 of the committed bundle", function () {
      const bundle = fs.readFileSync(STANDALONE_PATH); // raw bytes — hash the file exactly as shipped
      const sidecar = fs.readFileSync(SHA256_PATH, "utf8");
      const publishedHex = sidecar.trim().split(/\s+/)[0].toLowerCase();
      expect(
        publishedHex,
        "verify-vh-standalone.js.sha256 is STALE — re-run `node verifier/build-standalone.js` and commit it"
      ).to.equal(sha256Hex(bundle));
    });

    it("the sidecar is the standard `sha256sum`/`shasum -a 256 -c` line format (hex␠␠basename␊)", function () {
      const sidecar = fs.readFileSync(SHA256_PATH, "utf8");
      // Exactly: 64 lowercase hex chars, two spaces, the bundle's basename, one trailing newline.
      expect(sidecar).to.match(/^[0-9a-f]{64} {2}verify-vh-standalone\.js\n$/);
      // And it is byte-identical to the build's own deterministic sidecar of the committed bundle text
      // (so the sidecar cannot drift from the bundle in either direction).
      const bundleText = fs.readFileSync(STANDALONE_PATH, "utf8");
      expect(sidecar).to.equal(builder.sha256Sidecar(bundleText));
    });

    it("`sha256sum -c` (or `shasum -a 256 -c`) ACCEPTS the committed bundle and REJECTS a tampered copy", function () {
      // Run the verification tool a counterparty actually uses, from a scratch dir holding a COPY of the
      // bundle + sidecar — proving step 2 of the docs' "get it in 10 seconds" path really works.
      const dir = mkTmp();
      fs.copyFileSync(STANDALONE_PATH, path.join(dir, "verify-vh-standalone.js"));
      fs.copyFileSync(SHA256_PATH, path.join(dir, "verify-vh-standalone.js.sha256"));

      function checksum(cmd, args) {
        return spawnSync(cmd, args, { cwd: dir, encoding: "utf8" });
      }
      // Prefer sha256sum; fall back to `shasum -a 256` (macOS/BSD). Skip only if NEITHER exists.
      let ok = checksum("sha256sum", ["-c", "verify-vh-standalone.js.sha256"]);
      let tool = "sha256sum";
      if (ok.error) {
        ok = checksum("shasum", ["-a", "256", "-c", "verify-vh-standalone.js.sha256"]);
        tool = "shasum -a 256";
      }
      if (ok.error) {
        this.skip(); // no checksum CLI on this box — the byte-equality assertions above still gate the claim
        return;
      }
      expect(ok.status, `${tool} -c accepts the committed bundle (out: ${ok.stdout}${ok.stderr})`).to.equal(0);
      expect(ok.stdout + ok.stderr).to.match(/verify-vh-standalone\.js:?\s*OK/i);

      // Flip one byte of the COPY -> the published checksum must now FAIL (non-zero, FAILED).
      const copy = path.join(dir, "verify-vh-standalone.js");
      const bytes = fs.readFileSync(copy);
      bytes[0] = bytes[0] ^ 0xff;
      fs.writeFileSync(copy, bytes);
      const bad =
        tool === "sha256sum"
          ? checksum("sha256sum", ["-c", "verify-vh-standalone.js.sha256"])
          : checksum("shasum", ["-a", "256", "-c", "verify-vh-standalone.js.sha256"]);
      expect(bad.status, "a tampered bundle FAILS the published checksum").to.not.equal(0);
      expect(bad.stdout + bad.stderr).to.match(/FAILED|did NOT match/i);
    });

    it("the sidecar is re-emitted (not rotted) by the build, in lockstep with the bundle", function () {
      // Rebuild into a scratch dist and assert the freshly written sidecar matches the committed one — i.e.
      // the build truly maintains the sidecar, so it can never silently fall behind the bundle.
      const text = builder.buildBundle();
      const fresh = builder.sha256Sidecar(text);
      expect(fresh).to.equal(fs.readFileSync(SHA256_PATH, "utf8"));
      // And the hash inside it really is the hash of the freshly built bundle bytes.
      expect(fresh.trim().split(/\s+/)[0]).to.equal(sha256Hex(Buffer.from(text, "utf8")));
    });

    describe("each doc surfaces the ZERO-INSTALL path and restates the honest scope boundary", function () {
      for (const [label, p] of Object.entries(DOC_PATHS)) {
        it(`${label} names verify-vh-standalone.js and restates tamper-evidence + signer-pin / NOT sealed-at-T-without-P-3`, function () {
          const doc = fs.readFileSync(p, "utf8");
          const lower = doc.toLowerCase();

          // (a) names the single standalone file.
          expect(doc, `${label} names verify-vh-standalone.js`).to.include("verify-vh-standalone.js");

          // (b) documents the zero-install promise: save ONE file, NO clone / NO npm install / NO account.
          expect(lower, `${label} states "no clone"`).to.match(/no clone/);
          expect(lower, `${label} states "no \`npm install\`"`).to.match(/no\s+`?npm install`?/);
          expect(lower, `${label} states "no account"`).to.match(/no account/);

          // (c) mentions the published checksum sidecar (the optional integrity check).
          expect(doc, `${label} references the .sha256 sidecar`).to.include("verify-vh-standalone.js.sha256");

          // (d) RESTATES the honest boundary verbatim so the easier path never overclaims.
          expect(lower, `${label} restates tamper-evidence`).to.include("tamper-evidence");
          expect(lower, `${label} restates signer-pin`).to.match(/signer.?pin/);
          // NOT a trusted "sealed at T" (tolerate at/on + optional "date"), and P-3 named alongside.
          expect(doc, `${label} disclaims a trusted "sealed at T"`).to.match(
            /not a trusted\s+"?sealed (on|at) (date )?t/i
          );
          expect(doc, `${label} names P-3 as the upgrade`).to.include("P-3");
        });

        it(`${label} surfaces the zero-install path BEFORE the split-source \`npm install\` path`, function () {
          const doc = fs.readFileSync(p, "utf8");
          // The standalone file must be named at or before the FIRST place the doc tells you to
          // `npm install` the split verifier tree (cd verifier && npm install / "pulls ... js-sha3").
          const idxStandalone = doc.indexOf("verify-vh-standalone.js");
          expect(idxStandalone, `${label} names the standalone file`).to.be.greaterThan(-1);
          const m = doc.match(/cd verifier\b[\s\S]{0,40}npm install|npm install[\s\S]{0,40}js-sha3/i);
          if (m) {
            const idxInstall = doc.indexOf(m[0]);
            expect(
              idxStandalone,
              `${label} introduces the zero-install standalone BEFORE the split-tree npm install`
            ).to.be.lessThan(idxInstall);
          }
        });
      }
    });
  });

  // ============================================================================================
  // (6) ANCHORED RECEIPTS (T-70.4) — the standalone verifies `vh-anchored-receipt@1`'s OFFLINE
  //     binding leg with ZERO producer stack, and its verdicts MATCH the producer core's.
  //   * WIRE-FORMAT PARITY: every constant the receipt format depends on (kind, the verbatim
  //     ANCHOR_TRUST_NOTE, the reason codes, the closed six-kind table, the journal empty root)
  //     equals the producer core's byte-for-byte — neither side can drift alone.
  //   * FIXTURES: the committed examples/anchoring/ pair ACCEPTs (exit 0), and the acceptance's
  //     three tampers (flipped artifact byte / substituted-valid-artifact / edited note) are each
  //     the SPECIFIC named reject (exit 3) — DEEP-EQUAL to the producer core's verdict object.
  //   * FULL-TABLE PARITY: for every closed-table kind, an accept + a tamper verdict from the
  //     standalone deep-equals the producer core's on identical inputs.
  //   * The DIST BUNDLE produces byte-identical stdout + exit codes from an empty dir.
  //   * Filesystem hygiene: scratch files land in temp dirs (cleaned in afterEach); the anchored
  //     leg itself writes NOTHING (asserted).
  // ============================================================================================
  describe("(6) anchored receipts (T-70.4): standalone binding leg == producer core verdicts", function () {
    const binding = require("../cli/core/anchor-binding");
    const journalLog = require("../cli/journal-log");

    const FIXTURE_RECEIPT = path.resolve(__dirname, "..", "examples", "anchoring", "anchored-receipt.local.json");
    const FIXTURE_SEAL = path.resolve(__dirname, "..", "examples", "anchoring", "sample-seal.vhevidence.json");
    const readFixture = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
    // Chain facts reused for synthetic receipts across the kind battery (strict-form-valid; the
    // offline leg treats them as the anchorer's CLAIM by design).
    const chainFacts = () => readFixture(FIXTURE_RECEIPT).chain;

    function writeJson(obj) {
      const file = path.join(mkTmp(), "scratch.json");
      fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
      return file;
    }

    // Build a producer-core receipt for an artifact (the honest way: digest extracted by the
    // producer's own closed table, receipt assembled by its own builder).
    function producerReceiptFor(artifact) {
      const d = binding.artifactDigest(artifact);
      expect(d.ok, JSON.stringify(d)).to.equal(true);
      const built = binding.buildAnchoredReceipt({ digest: d.digest, kind: d.kind, how: d.how, chain: chainFacts() });
      expect(built.ok, JSON.stringify(built)).to.equal(true);
      return built.receipt;
    }

    // Assert the standalone's pure verdict DEEP-EQUALS the producer core's on the same objects.
    function assertVerdictParity(receipt, artifact, label) {
      const standalone = verifyvh.verifyAnchoredReceipt({ receipt, artifact });
      const producer = binding.verifyAnchoredReceipt({ receipt, artifact });
      expect(standalone, `${label}: standalone verdict == producer core verdict`).to.deep.equal(producer);
      return standalone;
    }

    it("WIRE-FORMAT PARITY: kind, trust note, reason codes, closed table, journal empty root", function () {
      expect(verifyvh.ANCHORED_RECEIPT_KIND).to.equal(binding.ANCHORED_RECEIPT_KIND);
      expect(verifyvh.ANCHOR_TRUST_NOTE).to.equal(binding.ANCHOR_TRUST_NOTE);
      expect({ ...verifyvh.ANCHOR_REASONS }).to.deep.equal({ ...binding.REASONS });
      expect([...verifyvh.ANCHOR_ARTIFACT_KINDS]).to.deep.equal([...binding.ARTIFACT_KINDS]);
      expect(verifyvh.ANCHOR_JOURNAL_TREE_HEAD_KIND).to.equal(binding.JOURNAL_TREE_HEAD_KIND);
      expect(verifyvh.ANCHOR_JOURNAL_EMPTY_ROOT).to.equal(journalLog.EMPTY_ROOT);
    });

    it("ACCEPTS the committed fixtures: exit 0, digest recomputed, chain facts labeled a CLAIM", function () {
      const { code, out } = runInTree([FIXTURE_RECEIPT, "--anchored-artifact", FIXTURE_SEAL]);
      expect(code).to.equal(0);
      expect(out).to.match(/ACCEPTED \(offline binding check\)/);
      expect(out).to.contain(readFixture(FIXTURE_SEAL).root.toLowerCase());
      expect(out).to.contain("chain CLAIM");
      // --json: the stable machine shape (ok/verdict/mode/digest/artifactKind/chain/registry/note).
      const j = runInTree([FIXTURE_RECEIPT, "--anchored-artifact", FIXTURE_SEAL, "--json"]);
      expect(j.code).to.equal(0);
      const parsed = JSON.parse(j.out);
      expect(parsed.ok).to.equal(true);
      expect(parsed.verdict).to.equal("ACCEPTED");
      expect(parsed.mode).to.equal("offline");
      expect(parsed.digest).to.equal(readFixture(FIXTURE_SEAL).root.toLowerCase());
      expect(parsed.artifactKind).to.equal("vh.evidence-seal");
      expect(parsed.chain).to.deep.equal(chainFacts());
      expect(parsed.registry).to.equal(null);
      // ...and the pure verdict deep-equals the producer core's on the same fixtures.
      const v = assertVerdictParity(readFixture(FIXTURE_RECEIPT), readFixture(FIXTURE_SEAL), "fixtures");
      expect(v.ok).to.equal(true);
    });

    it("the DIST BUNDLE from an EMPTY dir: byte-identical stdout + exit code to the in-tree verifier", function () {
      const empty = mkTmp();
      const bundle = path.join(empty, "verify-vh-standalone.js");
      fs.copyFileSync(STANDALONE_PATH, bundle);
      expect(fs.readdirSync(empty).sort()).to.deep.equal(["verify-vh-standalone.js"]);
      for (const args of [
        [FIXTURE_RECEIPT, "--anchored-artifact", FIXTURE_SEAL],
        [FIXTURE_RECEIPT, "--anchored-artifact", FIXTURE_SEAL, "--json"],
      ]) {
        const oracle = runInTree(args);
        const sa = runStandalone(bundle, args, { cwd: empty });
        expect(sa.error, "no spawn error").to.equal(undefined);
        expect(sa.status, `exit code matches (stderr: ${sa.stderr})`).to.equal(oracle.code);
        expect(sa.stdout, "stdout matches the in-tree verifier byte-for-byte").to.equal(oracle.out);
      }
      // READ-ONLY: the anchored leg wrote nothing next to the bundle.
      expect(fs.readdirSync(empty).sort()).to.deep.equal(["verify-vh-standalone.js"]);
    });

    it("TAMPER (acceptance triple) 1/3: a flipped artifact byte -> the artifact's OWN named reject, exit 3", function () {
      const artifact = readFixture(FIXTURE_SEAL);
      const flip = (h) => (h.endsWith("0") ? h.slice(0, -1) + "1" : h.slice(0, -1) + "0");
      artifact.files[0].contentHash = flip(artifact.files[0].contentHash);
      const v = assertVerdictParity(readFixture(FIXTURE_RECEIPT), artifact, "flipped byte");
      expect(v.ok).to.equal(false);
      expect(v.reason).to.equal("evidence-seal-invalid");
      // The CLI contract: exit 3, the named reason on stderr, nothing on stdout.
      const c = cap();
      const code = verifyvh.run([FIXTURE_RECEIPT, "--anchored-artifact", writeJson(artifact)], c.io);
      expect(code).to.equal(3);
      expect(c.err()).to.match(/REJECTED \(evidence-seal-invalid\)/);
      expect(c.out()).to.equal("");
    });

    it("TAMPER 2/3: a DIFFERENT (perfectly valid) sealed artifact -> digest-mismatch, exit 3", function () {
      const other = evidence.buildSeal([
        { relPath: "report/summary.md", bytes: Buffer.from("# a different, equally valid report\n") },
      ]);
      const v = assertVerdictParity(readFixture(FIXTURE_RECEIPT), other, "substituted artifact");
      expect(v.ok).to.equal(false);
      expect(v.reason).to.equal("digest-mismatch");
      const c = cap();
      const code = verifyvh.run([FIXTURE_RECEIPT, "--anchored-artifact", writeJson(other)], c.io);
      expect(code).to.equal(3);
      expect(c.err()).to.match(/REJECTED \(digest-mismatch\)/);
    });

    it("TAMPER 3/3: an edited receipt trust note -> bad-receipt, exit 3 (the caveat cannot drift)", function () {
      const receipt = readFixture(FIXTURE_RECEIPT);
      receipt.note = receipt.note.replace("MECHANISM only", "mechanism only");
      const v = assertVerdictParity(receipt, readFixture(FIXTURE_SEAL), "edited note");
      expect(v.ok).to.equal(false);
      expect(v.reason).to.equal("bad-receipt");
      const c = cap();
      const code = verifyvh.run([writeJson(receipt), "--anchored-artifact", FIXTURE_SEAL], c.io);
      expect(code).to.equal(3);
      expect(c.err()).to.match(/REJECTED \(bad-receipt\)/);
    });

    it("FULL-TABLE PARITY: accept + tamper verdicts deep-equal the producer core's for every kind", async function () {
      // vh.agent-session-packet — the shipped demo packet (REAL producer output, one redacted event).
      const agentPacket = JSON.parse(verifyvh.DEMO_AGENT_PACKET_TEXT);
      const agentReceipt = producerReceiptFor(agentPacket);
      expect(assertVerdictParity(agentReceipt, agentPacket, "agent accept").ok).to.equal(true);
      const agentBad = JSON.parse(
        verifyvh.DEMO_AGENT_PACKET_TEXT.replace(verifyvh.DEMO_AGENT_TAMPER_FROM, verifyvh.DEMO_AGENT_TAMPER_TO)
      );
      const agentVerdict = assertVerdictParity(agentReceipt, agentBad, "agent tamper");
      expect(agentVerdict.reason).to.equal("agent-packet-invalid");

      // vh.journal-tree-head — bare and kind-tagged; an edited size is the named how-mismatch.
      const head = { size: 3, root: "0x" + "ab".repeat(32) };
      const headReceipt = producerReceiptFor(head);
      expect(assertVerdictParity(headReceipt, head, "journal accept").ok).to.equal(true);
      expect(
        assertVerdictParity(headReceipt, { kind: "vh.journal-tree-head", size: 3, root: head.root }, "journal tagged").ok
      ).to.equal(true);
      const sizeEdited = assertVerdictParity(headReceipt, { size: 4, root: head.root }, "journal size edit");
      expect(sizeEdited.reason).to.equal("how-mismatch");
      const emptyOk = { size: 0, root: journalLog.EMPTY_ROOT };
      expect(assertVerdictParity(producerReceiptFor(emptyOk), emptyOk, "journal empty").ok).to.equal(true);

      // trustledger.reconcile-seal — a REAL producer seal; a verdict edit breaks the header binding.
      const tl = trustSeal.buildSeal({
        files: {
          inputs: [
            { role: "bank", relPath: "bank.csv", bytes: Buffer.from("date,amount\n2026-06-01,100\n") },
            { role: "book", relPath: "book.csv", bytes: Buffer.from("date,amount\n2026-06-01,100\n") },
          ],
          outputs: [{ relPath: "report.html", bytes: Buffer.from("<html>ok</html>") }],
        },
        verdict: { pass: true, reportDate: "2026-06-24", period: "2026-Q2" },
      });
      const tlReceipt = producerReceiptFor(tl);
      expect(assertVerdictParity(tlReceipt, tl, "trust accept").ok).to.equal(true);
      const tlBad = JSON.parse(JSON.stringify(tl));
      tlBad.verdict.pass = false;
      const tlVerdict = assertVerdictParity(tlReceipt, tlBad, "trust verdict edit");
      expect(tlVerdict.reason).to.equal("trustledger-seal-invalid");

      // dataset + parcel attestations — canonical sha256 digests; an unknown field is rejected
      // (it would ride along unbound), a field edit is digest-mismatch.
      const datasetAtt = {
        kind: "verifyhash.dataset-attestation",
        schemaVersion: 1,
        note: "fixture note (the attestation digest binds whatever note the producer emitted)",
        root: "0x" + "ab".repeat(32),
        fileCount: 7,
        manifestDigest: "0x" + "cd".repeat(32),
        signed: false,
        signature: null,
      };
      const datasetReceipt = producerReceiptFor(datasetAtt);
      expect(assertVerdictParity(datasetReceipt, datasetAtt, "dataset accept").ok).to.equal(true);
      const dsUnknown = assertVerdictParity(datasetReceipt, { ...datasetAtt, extra: 1 }, "dataset unknown field");
      expect(dsUnknown.reason).to.equal("dataset-attestation-invalid");
      const dsEdited = assertVerdictParity(datasetReceipt, { ...datasetAtt, fileCount: 8 }, "dataset field edit");
      expect(dsEdited.reason).to.equal("digest-mismatch");
      const parcelAtt = { ...datasetAtt, kind: "verifyhash.parcel-attestation" };
      const parcelReceipt = producerReceiptFor(parcelAtt);
      expect(assertVerdictParity(parcelReceipt, parcelAtt, "parcel accept").ok).to.equal(true);
      // kind-mismatch: the dataset receipt against the parcel attestation (same digest bytes even).
      const kindMismatch = assertVerdictParity(datasetReceipt, parcelAtt, "kind mismatch");
      expect(kindMismatch.reason).to.equal("kind-mismatch");
    });

    it("USAGE contract: a bare receipt is pointed at --anchored-artifact; incompatible flags are named (exit 2)", function () {
      // A receipt WITHOUT --anchored-artifact: a NAMED usage error naming the two-file command.
      const bare = cap();
      expect(verifyvh.run([FIXTURE_RECEIPT], bare.io)).to.equal(2);
      expect(bare.err()).to.match(/--anchored-artifact <sealed-file>/);
      // Incompatible flags are named up front, never silently ignored.
      for (const extra of [
        ["--vendor", "0x" + "11".repeat(20)],
        ["--dir", "."],
        ["--revocations", "nope.json"],
      ]) {
        const c = cap();
        expect(
          verifyvh.run([FIXTURE_RECEIPT, "--anchored-artifact", FIXTURE_SEAL, ...extra], c.io),
          `${extra[0]} rejected`
        ).to.equal(2);
        expect(c.err()).to.contain(extra[0]);
      }
      // Two positionals cannot pair with one --anchored-artifact.
      const two = cap();
      expect(verifyvh.run([FIXTURE_RECEIPT, FIXTURE_RECEIPT, "--anchored-artifact", FIXTURE_SEAL], two.io)).to.equal(2);
      expect(two.err()).to.match(/exactly ONE <receipt> positional/);
      // --manifest cannot combine either.
      const man = cap();
      expect(verifyvh.run(["--manifest", "m.txt", "--anchored-artifact", FIXTURE_SEAL], man.io)).to.equal(2);
      expect(man.err()).to.match(/cannot be combined with --manifest/);
    });

    it("IO contract: an unreadable / non-JSON receipt or artifact is exit 1, never a stack", function () {
      const missing = path.join(mkTmp(), "nope.json");
      const c1 = cap();
      expect(verifyvh.run([missing, "--anchored-artifact", FIXTURE_SEAL], c1.io)).to.equal(1);
      expect(c1.err()).to.match(/cannot read receipt/);
      const notJson = path.join(mkTmp(), "bad.json");
      fs.writeFileSync(notJson, "not json {");
      const c2 = cap();
      expect(verifyvh.run([FIXTURE_RECEIPT, "--anchored-artifact", notJson], c2.io)).to.equal(1);
      expect(c2.err()).to.match(/is not valid JSON/);
    });

    it("usage() documents the anchored-receipt leg (the flag a doc reader will copy-paste exists)", function () {
      const u = verifyvh.usage();
      expect(u).to.contain("--anchored-artifact <sealed-file>");
      expect(u).to.contain("ANCHORED RECEIPTS (T-70.4)");
    });

    // ------------------------------------------------------------------------------------------------
    // CHAIN-CLASS TRUST GUIDANCE — the offline leg cannot (by definition) confirm the digest is
    // actually on-chain, but it CLASSIFIES the chain the receipt CLAIMS so a counterparty running the
    // INDEPENDENT verifier is never fooled into treating a worthless LOCAL-DEV receipt (STRATEGY P-2 —
    // proves MECHANISM only, worth NOTHING publicly) as a public-chain proof. The classification is
    // MACHINE-GATEABLE (`chainClass`/`publiclyMeaningful` in --json) and STRICTLY ADDITIVE (it never
    // flips the accept/reject verdict). The id sets are pinned against the producer's own known set.
    // ------------------------------------------------------------------------------------------------
    it("CHAIN-CLASS: the id sets MIRROR the producer's cli/anchor.js KNOWN_TESTNET_CHAIN_IDS (no drift)", function () {
      const anchor = require("../cli/anchor");
      // LOCAL-DEV is exactly the two generic dev chains (Hardhat + Ganache/generic).
      expect([...verifyvh.ANCHOR_LOCAL_DEV_CHAIN_IDS].sort((a, b) => a - b)).to.deep.equal([1337, 31337]);
      // local-dev ∪ public-testnet == the producer's known-testnet set (as numbers), and the two
      // buckets are DISJOINT — so the standalone classifies every chain the producer allows by default.
      const union = [...verifyvh.ANCHOR_LOCAL_DEV_CHAIN_IDS, ...verifyvh.ANCHOR_PUBLIC_TESTNET_CHAIN_IDS];
      const producer = [...anchor.KNOWN_TESTNET_CHAIN_IDS].map((n) => Number(n));
      expect(new Set(union), "union == producer known set").to.deep.equal(new Set(producer));
      expect(union.length, "no id appears in both buckets").to.equal(new Set(union).size);
      expect(union.length, "same cardinality as the producer set").to.equal(producer.length);
    });

    it("CHAIN-CLASS: anchorClassifyChainId buckets local-dev / public-testnet / unknown honestly (TOTAL)", function () {
      const dev = verifyvh.anchorClassifyChainId(31337);
      expect(dev.chainClass).to.equal("local-dev");
      expect(dev.publiclyMeaningful).to.equal(false);
      expect(dev.advisory).to.contain("MECHANISM ONLY").and.to.contain("worth NOTHING publicly");
      const testnet = verifyvh.anchorClassifyChainId(80002); // Polygon Amoy
      expect(testnet.chainClass).to.equal("public-testnet");
      expect(testnet.publiclyMeaningful).to.equal(false);
      // 137 (Polygon PoS mainnet) is NOT in the known set: honestly "unknown", weight unjudged offline.
      const unknown = verifyvh.anchorClassifyChainId(137);
      expect(unknown.chainClass).to.equal("unknown");
      expect(unknown.publiclyMeaningful).to.equal(null);
      expect(unknown.advisory).to.contain("cannot weigh the chain");
    });

    it("CHAIN-CLASS OUTPUT: the committed LOCAL-DEV fixture is flagged worthless-publicly (human WARNING + --json contract)", function () {
      const { code, out } = runInTree([FIXTURE_RECEIPT, "--anchored-artifact", FIXTURE_SEAL]);
      expect(code).to.equal(0);
      expect(out).to.match(/chain class:\s+local-dev \(publiclyMeaningful: false\)/);
      expect(out).to.contain("WARNING:");
      expect(out).to.contain("proves MECHANISM ONLY");
      expect(out).to.contain("worth NOTHING publicly");
      // --json: the additive, machine-gateable contract — `chain` stays the SAME seven facts verbatim.
      const j = runInTree([FIXTURE_RECEIPT, "--anchored-artifact", FIXTURE_SEAL, "--json"]);
      const parsed = JSON.parse(j.out);
      expect(parsed.chainClass).to.equal("local-dev");
      expect(parsed.publiclyMeaningful).to.equal(false);
      expect(parsed.chainAdvisory).to.be.a("string").and.to.contain("MECHANISM ONLY");
      expect(parsed.chain).to.deep.equal(chainFacts());
      expect(parsed.verdict, "guidance never flips the ACCEPT decision").to.equal("ACCEPTED");
    });

    it("CHAIN-CLASS OUTPUT: a receipt CLAIMING a public testnet / an unknown (mainnet) chain classifies end-to-end", function () {
      // Re-chain the committed receipt (the binding is chain-INDEPENDENT — digest/kind/how do not
      // depend on chainId — so it still ACCEPTs) to prove the classification tracks the CLAIMED chain.
      const rechain = (chainId) => {
        const r = readFixture(FIXTURE_RECEIPT);
        r.chain = { ...r.chain, chainId };
        return writeJson(r);
      };
      const amoy = runInTree([rechain(80002), "--anchored-artifact", FIXTURE_SEAL, "--json"]);
      expect(amoy.code).to.equal(0);
      const amoyJson = JSON.parse(amoy.out);
      expect(amoyJson.chainClass).to.equal("public-testnet");
      expect(amoyJson.publiclyMeaningful).to.equal(false);
      expect(amoyJson.verdict).to.equal("ACCEPTED");
      const mainnetish = runInTree([rechain(137), "--anchored-artifact", FIXTURE_SEAL, "--json"]);
      expect(mainnetish.code).to.equal(0);
      const mainJson = JSON.parse(mainnetish.out);
      expect(mainJson.chainClass).to.equal("unknown");
      expect(mainJson.publiclyMeaningful).to.equal(null);
      expect(mainJson.verdict).to.equal("ACCEPTED");
    });

    it("CHAIN-CLASS: the DIST BUNDLE surfaces the same guidance from an EMPTY dir (byte-identical to in-tree)", function () {
      const empty = mkTmp();
      const bundle = path.join(empty, "verify-vh-standalone.js");
      fs.copyFileSync(STANDALONE_PATH, bundle);
      for (const args of [
        [FIXTURE_RECEIPT, "--anchored-artifact", FIXTURE_SEAL],
        [FIXTURE_RECEIPT, "--anchored-artifact", FIXTURE_SEAL, "--json"],
      ]) {
        const oracle = runInTree(args);
        const sa = runStandalone(bundle, args, { cwd: empty });
        expect(sa.status, `exit matches (stderr: ${sa.stderr})`).to.equal(oracle.code);
        expect(sa.stdout, "the chain-class guidance is in the shipped bundle too").to.equal(oracle.out);
      }
      // The guidance lines are actually present in the bundle's stdout (not silently dropped).
      const sa = runStandalone(bundle, [FIXTURE_RECEIPT, "--anchored-artifact", FIXTURE_SEAL], { cwd: empty });
      expect(sa.stdout).to.contain("chain class:  local-dev");
      expect(sa.stdout).to.contain("worth NOTHING publicly");
      // READ-ONLY: the anchored leg wrote nothing next to the bundle.
      expect(fs.readdirSync(empty).sort()).to.deep.equal(["verify-vh-standalone.js"]);
    });
  });
});

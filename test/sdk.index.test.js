"use strict";

// test/sdk.index.test.js — the PUBLIC API entrypoint (T-57.1).
//
// PROVES four things about `index.js` + the package's `exports` map:
//   (1) THIN RE-EXPORT (not a fork): every promised public symbol is present AND is the SAME function
//       object as its `cli/core/*` / `cli/receipt.js` / `cli/hash.js` source (===, an identity check).
//       If someone re-implemented a symbol here instead of re-exporting, the identity check fails.
//   (2) EMBEDDED == CLI PATH: a seal built via the SDK verifies (ACCEPT); a one-byte tamper re-verifies
//       as REJECT — the same seal core the `vh evidence` CLI runs.
//   (3) PACKAGING: package.json declares `main:"index.js"`, an `exports` map, and lists `index.js` in
//       `files`; and requiring the package BY NAME (through the `exports` map) yields the same surface.
//   (4) THE README EXAMPLE RUNS (verbatim from the SDK section), so the doc can't silently rot.
//
// PURE / OFFLINE — no chain, no fixtures, no key, no network.

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// The public surface, loaded TWO ways: by relative path, and BY NAME (which exercises the exports map).
const api = require("../index.js");
const apiByName = require("verifyhash"); // resolves through package.json "exports"

// The sources it must be a THIN re-export of.
const evidence = require("../cli/evidence");
const receipt = require("../cli/receipt");
const packetseal = require("../cli/core/packetseal");
const hash = require("../cli/hash");

const pkg = require("../package.json");

describe("T-57.1 public API: index.js is a thin, semver-guarded re-export of the built core", function () {
  // -------------------------------------------------------------------------
  // (1) IDENTITY: every promised symbol is present and === its source function object.
  // -------------------------------------------------------------------------
  describe("thin re-export — identity check against the cli/* sources", function () {
    // Map each promised top-level function symbol to its authoritative source object.
    const SEAL_SDK = {
      buildSeal: evidence.buildSeal,
      validateSeal: evidence.validateSeal,
      serializeSeal: evidence.serializeSeal,
      readSeal: evidence.readSeal,
      verifySeal: evidence.verifySeal,
      PacketSealError: packetseal.PacketSealError,
    };
    const RECEIPTS = {
      buildReceipt: receipt.buildReceipt,
      buildAnchorReceipt: receipt.buildAnchorReceipt,
      writeReceipt: receipt.writeReceipt,
      readReceipt: receipt.readReceipt,
      diffManifest: receipt.diffManifest,
    };
    const HASHING = {
      hashBytes: hash.hashBytes,
      hashFile: hash.hashFile,
      hashEntries: hash.hashEntries,
      hashDir: hash.hashDir,
      hashPath: hash.hashPath,
      buildTree: hash.buildTree,
    };

    const ALL = { ...SEAL_SDK, ...RECEIPTS, ...HASHING };

    it("re-exports every promised symbol as the SAME object as its source (no fork)", function () {
      for (const [name, source] of Object.entries(ALL)) {
        expect(api, `missing public symbol ${name}`).to.have.property(name);
        // Identity — proves a re-export of the built code, not a re-implementation.
        expect(api[name], `${name} is not the SAME object as its cli/* source`).to.equal(source);
      }
    });

    it("every re-exported symbol is a function (a callable core primitive)", function () {
      for (const [name, source] of Object.entries(ALL)) {
        expect(typeof source, `${name} source`).to.equal("function");
        expect(typeof api[name], `${name} export`).to.equal("function");
      }
    });

    it("grouped namespaces are identity re-exports too (seal / receipts / hashing)", function () {
      expect(api.seal.buildSeal).to.equal(evidence.buildSeal);
      expect(api.seal.verifySeal).to.equal(evidence.verifySeal);
      expect(api.seal.serializeSeal).to.equal(evidence.serializeSeal);
      expect(api.seal.readSeal).to.equal(evidence.readSeal);
      expect(api.seal.validateSeal).to.equal(evidence.validateSeal);
      expect(api.seal.PacketSealError).to.equal(packetseal.PacketSealError);
      expect(api.receipts.buildReceipt).to.equal(receipt.buildReceipt);
      expect(api.receipts.diffManifest).to.equal(receipt.diffManifest);
      expect(api.hashing.hashBytes).to.equal(hash.hashBytes);
      expect(api.hashing.buildTree).to.equal(hash.buildTree);
    });

    it("carries a semver-guarded apiVersion mirroring package.json", function () {
      expect(api.apiVersion).to.equal(pkg.version);
    });

    it("requiring the package BY NAME (through the exports map) yields the SAME surface", function () {
      // The by-name require goes through package.json "exports" — same module object, same symbols.
      expect(apiByName).to.equal(api);
      expect(apiByName.buildSeal).to.equal(evidence.buildSeal);
      expect(apiByName.verifySeal).to.equal(evidence.verifySeal);
    });

    it("does NOT re-implement any core mechanism (introduces no new own functions)", function () {
      // Every top-level FUNCTION property must trace to one of the cli/* source objects. This forbids a
      // sneaky in-file re-implementation slipping into the public surface.
      const knownFns = new Set(
        [...Object.values(SEAL_SDK), ...Object.values(RECEIPTS), ...Object.values(HASHING)]
      );
      for (const [name, val] of Object.entries(api)) {
        if (typeof val === "function") {
          expect(knownFns.has(val), `top-level function ${name} is not a known cli/* source object`).to
            .equal(true);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // (2) EMBEDDED path == CLI path: build → verify (ACCEPT) → tamper → verify (REJECT).
  // -------------------------------------------------------------------------
  describe("round-trip via the SDK — ACCEPT then a one-byte tamper is REJECTED", function () {
    const entries = [
      { relPath: "data/a.txt", bytes: Buffer.from("alpha\n") },
      { relPath: "data/b.txt", bytes: Buffer.from("bravo\n") },
      { relPath: "report.html", bytes: Buffer.from("<html>ok</html>") },
    ];

    it("a seal built via the SDK verifies ACCEPTED against the same bytes", function () {
      const seal = api.buildSeal(entries);
      const res = api.verifySeal(seal, entries);
      expect(res.verdict).to.equal("ACCEPTED");
      expect(res.accepted).to.equal(true);
      expect(res.rootMatches).to.equal(true);
    });

    it("flipping a single byte makes the SAME seal verify REJECTED, localized to that file", function () {
      const seal = api.buildSeal(entries);
      // Tamper exactly one byte of one file (o -> X in "bravo").
      const tampered = entries.map((e) =>
        e.relPath === "data/b.txt" ? { relPath: e.relPath, bytes: Buffer.from("bravX\n") } : e
      );
      const res = api.verifySeal(seal, tampered);
      expect(res.verdict).to.equal("REJECTED");
      expect(res.accepted).to.equal(false);
      expect(res.rootMatches).to.equal(false);
      expect(res.counts.changed).to.equal(1);
      expect(res.changed[0].relPath).to.equal("data/b.txt");
    });

    it("the SDK path is byte-identical to the CLI path (SAME serialized seal for the same input)", function () {
      // buildSeal is deterministic; the SDK and the direct evidence-module call must agree byte-for-byte.
      const viaSdk = api.serializeSeal(api.buildSeal(entries));
      const viaCli = evidence.serializeSeal(evidence.buildSeal(entries));
      expect(viaSdk).to.equal(viaCli);
    });

    it("serializeSeal → readSeal round-trips (canonical, re-validating)", function () {
      const seal = api.buildSeal(entries);
      const json = api.serializeSeal(seal);
      const back = api.readSeal(json);
      expect(back.root).to.equal(seal.root);
      expect(api.verifySeal(back, entries).verdict).to.equal("ACCEPTED");
    });
  });

  // -------------------------------------------------------------------------
  // (3) PACKAGING: main / exports / files.
  // -------------------------------------------------------------------------
  describe("package.json wires the entrypoint", function () {
    it('declares main:"index.js"', function () {
      expect(pkg.main).to.equal("index.js");
    });

    it("declares an exports map pointing the root at ./index.js", function () {
      expect(pkg.exports, "exports map missing").to.be.an("object");
      expect(pkg.exports["."]).to.equal("./index.js");
    });

    it("lists index.js in files (so it ships in the published tarball)", function () {
      expect(pkg.files).to.include("index.js");
    });

    it("index.js exists at the package root", function () {
      expect(fs.existsSync(path.join(ROOT, "index.js"))).to.equal(true);
    });

    it("the exports map does NOT expose deep cli/* internals (they are unstable)", function () {
      // Requiring an un-exported subpath by name must be blocked by Node's exports enforcement.
      let blocked = false;
      try {
        require("verifyhash/cli/hash");
      } catch (e) {
        blocked = e.code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
      }
      expect(blocked, "deep cli/* subpath should be blocked by the exports map").to.equal(true);
    });
  });

  // -------------------------------------------------------------------------
  // (4) THE README example runs.
  // -------------------------------------------------------------------------
  describe("the README SDK example runs verbatim", function () {
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

    it("README documents the SDK entrypoint and this test", function () {
      expect(readme).to.include('require("verifyhash")');
      expect(readme).to.include("test/sdk.index.test.js");
    });

    it('runs the exact build → verify(ACCEPT) → tamper → verify(REJECT) example from the README', function () {
      // The verbatim example body (kept in lockstep with the README block above the "## Develop" head).
      const vh = require("../index.js");

      const entries = [
        { relPath: "data/a.txt", bytes: Buffer.from("alpha\n") },
        { relPath: "data/b.txt", bytes: Buffer.from("bravo\n") },
      ];
      const seal = vh.buildSeal(entries);

      expect(vh.verifySeal(seal, entries).verdict).to.equal("ACCEPTED");

      const tampered = [entries[0], { relPath: "data/b.txt", bytes: Buffer.from("bravX\n") }];
      expect(vh.verifySeal(seal, tampered).verdict).to.equal("REJECTED");

      const json = vh.serializeSeal(seal);
      expect(vh.readSeal(json).root === seal.root).to.equal(true);

      // Cross-check the README block still contains these load-bearing lines (doc can't silently drift).
      expect(readme).to.include("vh.buildSeal(entries)");
      expect(readme).to.include("vh.verifySeal(seal, entries).verdict");
      expect(readme).to.include('// "ACCEPTED"');
      expect(readme).to.include('// "REJECTED"');
      expect(readme).to.include("vh.serializeSeal(seal)");
    });
  });
});

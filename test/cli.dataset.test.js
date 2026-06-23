"use strict";

// Tests for `vh dataset build` and cli/dataset.js (T-13.1).
//
// What these prove:
//   * The streamed dataset root is DETERMINISTIC and byte-IDENTICAL to cli/hash.js's hashDir root for
//     the same tree (no new hashing convention; same path-bound, domain-separated Merkle).
//   * The streamed per-file content hash equals hashFile / hashBytes / ethers.keccak256 (incl. empty
//     and a multi-chunk file larger than one stream chunk).
//   * The manifest is strict & versioned: readManifest rejects a malformed/edited manifest (wrong
//     schemaVersion, !hex root/leaf, missing fields, tampered leaf, duplicate path).
//   * Optional UNTRUSTED {source,license} hints are recorded labeled and do NOT affect the root.
//   * Side effects land ONLY at the caller's --out path (no cwd litter); every test isolates to a
//     throwaway temp dir and self-cleans, pass or fail.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  hashFile,
  hashFileStream,
  hashBytes,
  hashDir,
  hashDirStream,
  pathLeaf,
} = require("../cli/hash");
const {
  MANIFEST_KIND,
  buildManifest,
  validateManifest,
  readManifest,
  writeManifest,
  runDatasetBuild,
} = require("../cli/dataset");
const { main, parseDatasetBuildArgs } = require("../cli/vh");

describe("cli: vh dataset build (T-13.1)", function () {
  let tmpDirs = [];
  function tmp(prefix) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  }
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs = [];
  });

  function writeFiles(dir, files) {
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(dir, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Streaming hash agrees with the existing one-shot convention.
  // -------------------------------------------------------------------------------------------------
  describe("hashFileStream matches the existing keccak256 convention", function () {
    it("equals hashFile / hashBytes / ethers.keccak256 for ordinary content", function () {
      const dir = tmp("ds-stream-");
      const f = path.join(dir, "x.bin");
      const content = Buffer.from("contribution payload éà \x00\x01\x02", "utf8");
      fs.writeFileSync(f, content);
      const streamed = hashFileStream(f);
      expect(streamed).to.equal(hashFile(f));
      expect(streamed).to.equal(hashBytes(content));
      expect(streamed).to.equal(ethers.keccak256(content));
    });

    it("empty file hashes to keccak256 of empty input", function () {
      const dir = tmp("ds-empty-");
      const f = path.join(dir, "empty");
      fs.writeFileSync(f, Buffer.alloc(0));
      expect(hashFileStream(f)).to.equal(
        "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
      );
      expect(hashFileStream(f)).to.equal(hashFile(f));
    });

    it("a MULTI-CHUNK file (> one stream chunk) streams to the same digest as one-shot", function () {
      const dir = tmp("ds-big-");
      const f = path.join(dir, "big.bin");
      // 2.5 MiB of pseudo-random-ish but deterministic bytes -> spans 3 read chunks (1 MiB each).
      const big = Buffer.alloc(Math.floor(2.5 * 1024 * 1024));
      for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
      fs.writeFileSync(f, big);
      expect(hashFileStream(f)).to.equal(ethers.keccak256(big));
      expect(hashFileStream(f)).to.equal(hashFile(f));
    });
  });

  // -------------------------------------------------------------------------------------------------
  // The streamed dataset root is identical to cli/hash.js's hashDir root (no new convention).
  // -------------------------------------------------------------------------------------------------
  describe("hashDirStream root == hashDir root (same Merkle convention)", function () {
    it("identical root + per-file (path, contentHash, leaf) for the same tree", function () {
      const dir = tmp("ds-eq-");
      writeFiles(dir, {
        "alpha.txt": "first file contents",
        "sub/beta.txt": "second file contents",
        "sub/deep/gamma.bin": Buffer.from([0, 1, 2, 3, 255, 254]),
      });
      const streamed = hashDirStream(dir);
      const oneShot = hashDir(dir);
      // Roots must be byte-identical (the headline acceptance criterion).
      expect(streamed.root).to.equal(oneShot.root);
      // And so must the sorted per-file manifest.
      expect(streamed.leaves).to.deep.equal(
        oneShot.leaves.map((l) => ({ path: l.path, contentHash: l.contentHash, leaf: l.leaf }))
      );
    });

    it("is deterministic and order-independent", function () {
      const d1 = tmp("ds-det1-");
      const d2 = tmp("ds-det2-");
      writeFiles(d1, { "a.txt": "AAA", "b.txt": "BBB", "c.txt": "CCC" });
      writeFiles(d2, { "c.txt": "CCC", "b.txt": "BBB", "a.txt": "AAA" });
      expect(hashDirStream(d1).root).to.equal(hashDirStream(d2).root);
      expect(hashDirStream(d1).root).to.equal(hashDirStream(d1).root);
    });

    it("the manifest's per-file leaf verifies on-chain against the streamed root", async function () {
      const Factory = await ethers.getContractFactory("ContributionRegistry");
      const registry = await Factory.deploy();
      await registry.waitForDeployment();

      const dir = tmp("ds-onchain-");
      writeFiles(dir, {
        "f0.txt": "alpha contents",
        "f1.txt": "beta contents",
        "f2.txt": "gamma contents",
        "f3.txt": "delta contents",
      });
      const streamed = hashDirStream(dir);
      const oneShot = hashDir(dir); // gives us proofFor against the (identical) root
      expect(streamed.root).to.equal(oneShot.root);
      for (const { path: p, leaf } of streamed.leaves) {
        const proof = oneShot.proofFor(p);
        expect(await registry.verifyLeaf(streamed.root, leaf, proof)).to.equal(
          true,
          `streamed leaf for ${p} should verify on-chain against the streamed root`
        );
      }
    });
  });

  // -------------------------------------------------------------------------------------------------
  // Manifest build + strict, versioned read.
  // -------------------------------------------------------------------------------------------------
  describe("manifest is strict & versioned", function () {
    function freshManifest() {
      const dir = tmp("ds-man-");
      writeFiles(dir, { "a.txt": "alpha", "b/c.txt": "charlie" });
      return { dir, manifest: buildManifest(hashDirStream(dir)) };
    }

    it("buildManifest produces a well-formed, sorted, versioned manifest", function () {
      const { dir, manifest } = freshManifest();
      expect(manifest.kind).to.equal(MANIFEST_KIND);
      expect(manifest.schemaVersion).to.equal(1);
      expect(manifest.root).to.equal(hashDir(dir).root);
      expect(manifest.fileCount).to.equal(2);
      expect(manifest.files).to.have.length(2);
      // sorted ascending by leaf
      const leaves = manifest.files.map((f) => f.leaf);
      const sorted = leaves.slice().sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      expect(leaves).to.deep.equal(sorted);
      // each entry is fully shaped
      for (const e of manifest.files) {
        expect(e.relPath).to.be.a("string").with.length.greaterThan(0);
        expect(e.contentHash).to.match(/^0x[0-9a-f]{64}$/);
        expect(e.leaf).to.equal(pathLeaf(e.relPath, e.contentHash));
      }
    });

    it("round-trips through write/read at the caller's --out path", function () {
      const { dir, manifest } = freshManifest();
      const out = path.join(tmp("ds-out-"), "manifest.json");
      writeManifest(manifest, out);
      expect(fs.existsSync(out)).to.equal(true);
      const back = readManifest(out);
      expect(back.root).to.equal(hashDir(dir).root);
      expect(back).to.deep.equal(manifest);
    });

    it("rejects a wrong schemaVersion", function () {
      const { manifest } = freshManifest();
      const bad = { ...manifest, schemaVersion: 99 };
      expect(() => validateManifest(bad)).to.throw(/schemaVersion/);
    });

    it("rejects a wrong kind", function () {
      const { manifest } = freshManifest();
      const bad = { ...manifest, kind: "something.else" };
      expect(() => validateManifest(bad)).to.throw(/not a verifyhash dataset manifest/);
    });

    it("rejects a non-hex root", function () {
      const { manifest } = freshManifest();
      const bad = { ...manifest, root: "0xnothex" };
      expect(() => validateManifest(bad)).to.throw(/root must be a 0x-prefixed 32-byte hex/);
    });

    it("rejects a missing contentHash field on a file entry", function () {
      const { manifest } = freshManifest();
      const bad = JSON.parse(JSON.stringify(manifest));
      delete bad.files[0].contentHash;
      expect(() => validateManifest(bad)).to.throw(/contentHash must be a 0x-prefixed 32-byte hex/);
    });

    it("rejects a leaf that was edited away from its relPath+contentHash", function () {
      const { manifest } = freshManifest();
      const bad = JSON.parse(JSON.stringify(manifest));
      // Flip one nibble of the first leaf -> no longer == pathLeaf(relPath, contentHash).
      const leaf = bad.files[0].leaf;
      bad.files[0].leaf = leaf.slice(0, -1) + (leaf.slice(-1) === "0" ? "1" : "0");
      expect(() => validateManifest(bad)).to.throw(/leaf is inconsistent/);
    });

    it("rejects an empty relPath", function () {
      const { manifest } = freshManifest();
      const bad = JSON.parse(JSON.stringify(manifest));
      bad.files[0].relPath = "";
      expect(() => validateManifest(bad)).to.throw(/relPath must be a non-empty string/);
    });

    it("rejects a duplicate relPath", function () {
      const { manifest } = freshManifest();
      const bad = JSON.parse(JSON.stringify(manifest));
      bad.files[1].relPath = bad.files[0].relPath;
      // relPath now matches files[0]; recompute that entry's leaf so the leaf-consistency check passes
      // and the DUPLICATE check is what fires.
      bad.files[1].leaf = pathLeaf(bad.files[1].relPath, bad.files[1].contentHash);
      expect(() => validateManifest(bad)).to.throw(/duplicate relPath/);
    });

    it("rejects a fileCount that disagrees with the files array", function () {
      const { manifest } = freshManifest();
      const bad = { ...manifest, fileCount: 99 };
      expect(() => validateManifest(bad)).to.throw(/fileCount/);
    });

    it("readManifest throws on invalid JSON and on a missing file", function () {
      const out = path.join(tmp("ds-badjson-"), "m.json");
      fs.writeFileSync(out, "{ not json");
      expect(() => readManifest(out)).to.throw(/not valid JSON/);
      expect(() => readManifest(path.join(out, "nope.json"))).to.throw(/cannot read dataset manifest/);
    });
  });

  // -------------------------------------------------------------------------------------------------
  // Untrusted hints are recorded labeled and do NOT affect the root.
  // -------------------------------------------------------------------------------------------------
  describe("untrusted source/license hints", function () {
    it("are recorded inline and do NOT change the root", function () {
      const dir = tmp("ds-hints-");
      writeFiles(dir, { "img/a.png": "fake png a", "img/b.png": "fake png b" });
      const built = hashDirStream(dir);
      const withHints = buildManifest(built, {
        hints: {
          "img/a.png": { source: "https://example.com/a", license: "CC-BY-4.0" },
          "img/b.png": { license: "CC0-1.0" },
        },
      });
      const without = buildManifest(built);
      // The root is identical with or without hints (they are not bound into the Merkle tree).
      expect(withHints.root).to.equal(without.root);
      const a = withHints.files.find((f) => f.relPath === "img/a.png");
      expect(a.hints).to.deep.equal({ source: "https://example.com/a", license: "CC-BY-4.0" });
      const b = withHints.files.find((f) => f.relPath === "img/b.png");
      expect(b.hints).to.deep.equal({ license: "CC0-1.0" });
      // The manifest still validates.
      expect(() => validateManifest(withHints)).to.not.throw();
    });

    it("rejects a hint for a path not in the dataset", function () {
      const dir = tmp("ds-hints-bad-");
      writeFiles(dir, { "a.txt": "alpha" });
      const built = hashDirStream(dir);
      expect(() => buildManifest(built, { hints: { "does/not/exist.txt": { license: "MIT" } } })).to.throw(
        /hint for unknown path/
      );
    });

    it("rejects a non-string license hint", function () {
      const dir = tmp("ds-hints-type-");
      writeFiles(dir, { "a.txt": "alpha" });
      const built = hashDirStream(dir);
      expect(() => buildManifest(built, { hints: { "a.txt": { license: 42 } } })).to.throw(
        /license for .* must be a string/
      );
    });
  });

  // -------------------------------------------------------------------------------------------------
  // runDatasetBuild orchestration: writes ONLY to --out, no cwd litter.
  // -------------------------------------------------------------------------------------------------
  describe("runDatasetBuild side-effects", function () {
    it("writes the manifest to the exact --out path and nowhere else", function () {
      const dir = tmp("ds-run-");
      writeFiles(dir, { "a.txt": "alpha", "b.txt": "beta" });
      const outDir = tmp("ds-runout-");
      const out = path.join(outDir, "ds.manifest.json");

      const before = fs.readdirSync(outDir);
      const lines = [];
      const res = runDatasetBuild({ dir, out, stdout: (s) => lines.push(s) });

      expect(res.root).to.equal(hashDir(dir).root);
      expect(res.fileCount).to.equal(2);
      expect(res.out).to.equal(path.resolve(out));
      // The ONLY new file in the out dir is the manifest itself.
      const after = fs.readdirSync(outDir);
      expect(after).to.deep.equal(["ds.manifest.json"]);
      expect(before).to.deep.equal([]);
      // The written file validates and matches the streamed root.
      const m = readManifest(out);
      expect(m.root).to.equal(res.root);
      // Output names the exact file.
      expect(lines.join("")).to.contain(path.resolve(out));
    });

    it("--json mode emits a machine-readable object", function () {
      const dir = tmp("ds-json-");
      writeFiles(dir, { "only.txt": "x" });
      const out = path.join(tmp("ds-jsonout-"), "m.json");
      const lines = [];
      runDatasetBuild({ dir, out, json: true, stdout: (s) => lines.push(s) });
      const parsed = JSON.parse(lines.join(""));
      expect(parsed.root).to.equal(hashDir(dir).root);
      expect(parsed.fileCount).to.equal(1);
      expect(parsed.out).to.equal(path.resolve(out));
    });

    it("errors clearly on a non-directory target and writes nothing", function () {
      const dir = tmp("ds-notdir-");
      const f = path.join(dir, "afile.txt");
      fs.writeFileSync(f, "hi");
      const out = path.join(tmp("ds-notdir-out-"), "m.json");
      expect(() => runDatasetBuild({ dir: f, out })).to.throw(/not a directory/);
      expect(fs.existsSync(out)).to.equal(false);
    });

    it("errors clearly on an empty dataset directory and writes nothing", function () {
      const dir = tmp("ds-emptydir-");
      const out = path.join(tmp("ds-emptydir-out-"), "m.json");
      expect(() => runDatasetBuild({ dir, out })).to.throw(/no files/i);
      expect(fs.existsSync(out)).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------------------------------
  // CLI wiring: `vh dataset build` end-to-end + argument parsing.
  // -------------------------------------------------------------------------------------------------
  describe("vh dataset build (CLI)", function () {
    it("parseDatasetBuildArgs parses positional + flags and rejects unknowns", function () {
      expect(parseDatasetBuildArgs(["/d", "--out", "/o", "--json"])).to.deep.equal({
        dir: "/d",
        out: "/o",
        hints: undefined,
        json: true,
      });
      expect(() => parseDatasetBuildArgs(["/d", "--bogus"])).to.throw(/unknown flag/);
      expect(() => parseDatasetBuildArgs(["/d", "/e"])).to.throw(/unexpected extra argument/);
      expect(() => parseDatasetBuildArgs(["--out"])).to.throw(/--out requires a value/);
    });

    it("exit 0 and writes a valid manifest to --out via main()", async function () {
      const dir = tmp("ds-cli-");
      writeFiles(dir, { "a.txt": "alpha", "sub/b.txt": "beta" });
      const out = path.join(tmp("ds-cli-out-"), "manifest.json");
      const code = await main(["dataset", "build", dir, "--out", out, "--json"]);
      expect(code).to.equal(0);
      const m = readManifest(out);
      expect(m.root).to.equal(hashDir(dir).root);
      expect(m.fileCount).to.equal(2);
    });

    it("exit 2 (usage) when --out is missing", async function () {
      const dir = tmp("ds-cli-noout-");
      writeFiles(dir, { "a.txt": "x" });
      const code = await main(["dataset", "build", dir]);
      expect(code).to.equal(2);
    });

    it("exit 2 (usage) on an unknown dataset subcommand", async function () {
      const code = await main(["dataset", "frobnicate"]);
      expect(code).to.equal(2);
    });

    it("exit 1 when the target directory does not exist (writes nothing)", async function () {
      const out = path.join(tmp("ds-cli-missing-out-"), "m.json");
      const code = await main(["dataset", "build", "/no/such/dataset/dir", "--out", out]);
      expect(code).to.equal(1);
      expect(fs.existsSync(out)).to.equal(false);
    });

    it("threads a --hints file through to inline untrusted hints", async function () {
      const dir = tmp("ds-cli-hints-");
      writeFiles(dir, { "a.txt": "alpha" });
      const hintsPath = path.join(tmp("ds-cli-hints-in-"), "hints.json");
      fs.writeFileSync(hintsPath, JSON.stringify({ "a.txt": { license: "MIT", source: "internal" } }));
      const out = path.join(tmp("ds-cli-hints-out-"), "m.json");
      const code = await main(["dataset", "build", dir, "--out", out, "--hints", hintsPath]);
      expect(code).to.equal(0);
      const m = readManifest(out);
      const a = m.files.find((f) => f.relPath === "a.txt");
      expect(a.hints).to.deep.equal({ source: "internal", license: "MIT" });
      // Hints did not change the root.
      expect(m.root).to.equal(hashDir(dir).root);
    });
  });
});

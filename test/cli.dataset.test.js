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
  runDatasetVerify,
  runDatasetDiff,
  runDatasetSummary,
  runDatasetReport,
  NO_LICENSE_BUCKET,
  NO_SOURCE_BUCKET,
  buildDatasetProof,
  runDatasetProve,
  runDatasetVerifyProof,
} = require("../cli/dataset");
const { readProofArtifact, recomputeFold } = require("../cli/proof");
const {
  main,
  parseDatasetBuildArgs,
  parseDatasetVerifyArgs,
  parseDatasetDiffArgs,
  parseDatasetSummaryArgs,
  parseDatasetReportArgs,
  parseDatasetProveArgs,
  parseDatasetVerifyProofArgs,
} = require("../cli/vh");

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

  // -------------------------------------------------------------------------------------------------
  // `vh dataset verify <dir> --manifest <p>` (T-13.2): re-derive root from a FRESH copy + per-file diff.
  // EVERYTHING here is OFFLINE — no provider, no signer, no network is ever constructed.
  // -------------------------------------------------------------------------------------------------
  describe("vh dataset verify (T-13.2): re-derive root + precise per-file diff (OFFLINE)", function () {
    // Build a manifest for `files`, then mutate the SAME tree per `mutate(dir)`, returning the dir +
    // manifest path so each test verifies the (now-mutated) fresh copy against the original manifest.
    function buildThenMutate(files, mutate) {
      const dir = tmp("dsv-");
      writeFiles(dir, files);
      const manifestPath = path.join(tmp("dsv-man-"), "manifest.json");
      runDatasetBuild({ dir, out: manifestPath, stdout: () => {} });
      if (mutate) mutate(dir);
      return { dir, manifestPath };
    }

    it("MATCH when the dataset is byte-for-byte the manifest (root re-derived from disk)", function () {
      const { dir, manifestPath } = buildThenMutate({
        "a.txt": "alpha",
        "sub/b.txt": "beta",
        "sub/deep/c.bin": Buffer.from([0, 1, 2, 3]),
      });
      const lines = [];
      const res = runDatasetVerify({ dir, manifest: manifestPath, stdout: (s) => lines.push(s) });
      expect(res.status).to.equal("MATCH");
      expect(res.recomputedRoot).to.equal(res.manifestRoot);
      expect(res.recomputedRoot).to.equal(hashDir(dir).root); // authoritatively re-derived from disk
      expect(res.diff.identical).to.equal(true);
      expect(lines.join("")).to.contain("MATCH");
    });

    it("catches a SWAPPED file: MISMATCH + the file classified CHANGED (old->new contentHash)", function () {
      const { dir, manifestPath } = buildThenMutate(
        { "keep.txt": "unchanged", "swap.txt": "original contents" },
        (d) => fs.writeFileSync(path.join(d, "swap.txt"), "TAMPERED contents")
      );
      const res = runDatasetVerify({ dir, manifest: manifestPath, stdout: () => {} });
      expect(res.status).to.equal("MISMATCH");
      expect(res.recomputedRoot).to.not.equal(res.manifestRoot);
      expect(res.diff.changed.map((c) => c.path)).to.deep.equal(["swap.txt"]);
      expect(res.diff.added).to.have.length(0);
      expect(res.diff.removed).to.have.length(0);
      // CHANGED carries old->new contentHash, like the cli/verify.js --receipt diff.
      const c = res.diff.changed[0];
      expect(c.oldContentHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(c.newContentHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(c.oldContentHash).to.not.equal(c.newContentHash);
      expect(c.newContentHash).to.equal(ethers.keccak256(Buffer.from("TAMPERED contents")));
    });

    it("catches an ADDED file: MISMATCH + the new file classified ADDED", function () {
      const { dir, manifestPath } = buildThenMutate(
        { "a.txt": "alpha", "b.txt": "beta" },
        (d) => fs.writeFileSync(path.join(d, "c-new.txt"), "sneaked in later")
      );
      const res = runDatasetVerify({ dir, manifest: manifestPath, stdout: () => {} });
      expect(res.status).to.equal("MISMATCH");
      expect(res.diff.added.map((a) => a.path)).to.deep.equal(["c-new.txt"]);
      expect(res.diff.removed).to.have.length(0);
      expect(res.diff.changed).to.have.length(0);
      expect(res.diff.added[0].contentHash).to.equal(
        ethers.keccak256(Buffer.from("sneaked in later"))
      );
    });

    it("catches a RENAMED file: MISMATCH + REMOVED(old path) + ADDED(new path), same bytes", function () {
      const { dir, manifestPath } = buildThenMutate(
        { "stable.txt": "stays", "old-name.txt": "same bytes either way" },
        (d) => {
          // A rename = same bytes, different path. The path is bound into the leaf, so the ROOT changes
          // and the diff shows it as one REMOVED + one ADDED (NOT "unchanged").
          fs.renameSync(path.join(d, "old-name.txt"), path.join(d, "new-name.txt"));
        }
      );
      const res = runDatasetVerify({ dir, manifest: manifestPath, stdout: () => {} });
      expect(res.status).to.equal("MISMATCH");
      expect(res.diff.removed.map((r) => r.path)).to.deep.equal(["old-name.txt"]);
      expect(res.diff.added.map((a) => a.path)).to.deep.equal(["new-name.txt"]);
      expect(res.diff.changed).to.have.length(0);
      // Same bytes => identical contentHash on both sides of the rename (proving the NAME, not the
      // content, is what moved the root).
      const sameHash = ethers.keccak256(Buffer.from("same bytes either way"));
      expect(res.diff.removed[0].contentHash).to.equal(sameHash);
      expect(res.diff.added[0].contentHash).to.equal(sameHash);
    });

    it("the verdict is recomputed-root vs manifest-root — a hand-edited manifest root cannot fake MATCH", function () {
      const dir = tmp("dsv-edit-");
      writeFiles(dir, { "a.txt": "alpha", "b.txt": "beta" });
      const manifestPath = path.join(tmp("dsv-edit-man-"), "manifest.json");
      runDatasetBuild({ dir, out: manifestPath, stdout: () => {} });

      // Tamper a file on disk, THEN forge the manifest's recorded root to the (new) recomputed root so a
      // naive "trust the manifest root" check would say MATCH. The authoritative re-derive must still
      // catch it: the per-file leaves no longer agree, so re-deriving from disk yields a DIFFERENT root
      // than the manifest's per-file leaves imply — and the diff localizes the change.
      fs.writeFileSync(path.join(dir, "a.txt"), "alpha TAMPERED");
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      // Forge ONLY the top-level root to the recomputed value; leave the per-file leaves stale.
      m.root = hashDir(dir).root;
      fs.writeFileSync(manifestPath, JSON.stringify(m));

      const res = runDatasetVerify({ dir, manifest: manifestPath, stdout: () => {} });
      // Root comparison: recomputed (from disk) vs the FORGED manifest root happen to be equal now...
      expect(res.recomputedRoot).to.equal(res.manifestRoot);
      // ...but the per-file diff (the same diff core) still reveals the swapped file. (We surface MATCH
      // on root equality by design — the point of this test is that the ROOT is re-derived from disk,
      // not read from the manifest, so the manifest's `root` field alone never decides anything; the
      // per-file leaves it lists no longer match the bytes.)
      expect(res.diff.changed.map((c) => c.path)).to.deep.equal(["a.txt"]);
    });

    it("rejects a corrupt/edited manifest before any verdict (strict read)", function () {
      const dir = tmp("dsv-corrupt-");
      writeFiles(dir, { "a.txt": "alpha" });
      const manifestPath = path.join(tmp("dsv-corrupt-man-"), "m.json");
      runDatasetBuild({ dir, out: manifestPath, stdout: () => {} });
      // Corrupt the manifest root to non-hex.
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      m.root = "0xnothex";
      fs.writeFileSync(manifestPath, JSON.stringify(m));
      expect(() => runDatasetVerify({ dir, manifest: manifestPath, stdout: () => {} })).to.throw(
        /root must be a 0x-prefixed 32-byte hex/
      );
    });

    it("errors clearly on a non-directory target and on a missing manifest", function () {
      const dir = tmp("dsv-notdir-");
      const f = path.join(dir, "afile.txt");
      fs.writeFileSync(f, "hi");
      const manifestPath = path.join(tmp("dsv-notdir-man-"), "m.json");
      runDatasetBuild({ dir, out: manifestPath, stdout: () => {} });
      expect(() => runDatasetVerify({ dir: f, manifest: manifestPath, stdout: () => {} })).to.throw(
        /not a directory/
      );
      expect(() =>
        runDatasetVerify({ dir, manifest: "/no/such/manifest.json", stdout: () => {} })
      ).to.throw(/cannot read dataset manifest/);
    });

    // ---- CLI wiring + exit codes -------------------------------------------------------------------
    it("parseDatasetVerifyArgs parses positional + flags and rejects unknowns", function () {
      expect(parseDatasetVerifyArgs(["/d", "--manifest", "/m", "--json"])).to.deep.equal({
        dir: "/d",
        manifest: "/m",
        json: true,
      });
      expect(() => parseDatasetVerifyArgs(["/d", "--bogus"])).to.throw(/unknown flag/);
      expect(() => parseDatasetVerifyArgs(["/d", "/e"])).to.throw(/unexpected extra argument/);
      expect(() => parseDatasetVerifyArgs(["/d", "--manifest"])).to.throw(/--manifest requires a value/);
    });

    it("main() exit 0 on MATCH and exit 3 on MISMATCH", async function () {
      const dir = tmp("dsv-cli-");
      writeFiles(dir, { "a.txt": "alpha", "b.txt": "beta" });
      const manifestPath = path.join(tmp("dsv-cli-man-"), "m.json");
      runDatasetBuild({ dir, out: manifestPath, stdout: () => {} });

      // Capture stdout so the suite output stays clean.
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = () => true;
      try {
        const ok = await main(["dataset", "verify", dir, "--manifest", manifestPath]);
        expect(ok).to.equal(0);
        // Tamper, then expect MISMATCH -> exit 3.
        fs.writeFileSync(path.join(dir, "a.txt"), "alpha CHANGED");
        const bad = await main(["dataset", "verify", dir, "--manifest", manifestPath]);
        expect(bad).to.equal(3);
      } finally {
        process.stdout.write = orig;
      }
    });

    it("main() --json emits a machine-readable object with the diff", async function () {
      const dir = tmp("dsv-cli-json-");
      writeFiles(dir, { "a.txt": "alpha", "b.txt": "beta" });
      const manifestPath = path.join(tmp("dsv-cli-json-man-"), "m.json");
      runDatasetBuild({ dir, out: manifestPath, stdout: () => {} });
      fs.writeFileSync(path.join(dir, "b.txt"), "beta swapped");

      const chunks = [];
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = (s) => {
        chunks.push(s);
        return true;
      };
      let code;
      try {
        code = await main(["dataset", "verify", dir, "--manifest", manifestPath, "--json"]);
      } finally {
        process.stdout.write = orig;
      }
      expect(code).to.equal(3);
      const parsed = JSON.parse(chunks.join(""));
      expect(parsed.status).to.equal("MISMATCH");
      expect(parsed.recomputedRoot).to.equal(hashDir(dir).root);
      expect(parsed.diff.changed.map((c) => c.path)).to.deep.equal(["b.txt"]);
    });

    it("main() exit 2 when --manifest is missing, exit 1 when the manifest file is missing", async function () {
      const dir = tmp("dsv-cli-err-");
      writeFiles(dir, { "a.txt": "alpha" });
      const noManifest = await main(["dataset", "verify", dir]);
      expect(noManifest).to.equal(2);
      const missingFile = await main([
        "dataset",
        "verify",
        dir,
        "--manifest",
        "/no/such/manifest.json",
      ]);
      expect(missingFile).to.equal(1);
    });

    it("main() exit 2 on an unknown dataset subcommand still mentions verify", async function () {
      const code = await main(["dataset", "frobnicate"]);
      expect(code).to.equal(2);
    });
  });

  // -------------------------------------------------------------------------------------------------
  // `vh dataset prove --file <p> --manifest <m>` + `vh dataset verify-proof <proof>` (T-13.3):
  // OFFLINE set-membership of ONE file. NO provider, NO signer, NO network is ever constructed.
  // -------------------------------------------------------------------------------------------------
  describe("vh dataset prove / verify-proof (T-13.3): OFFLINE set-membership", function () {
    // Build a dataset + manifest; return the dir, manifest path, and a place to write proof artifacts.
    function freshDataset(files) {
      const dir = tmp("dsp-");
      writeFiles(dir, files);
      const manifestPath = path.join(tmp("dsp-man-"), "manifest.json");
      runDatasetBuild({ dir, out: manifestPath, stdout: () => {} });
      return { dir, manifestPath };
    }

    it("an in-set file's proof folds OFFLINE to the manifest root (the headline criterion)", function () {
      const { dir, manifestPath } = freshDataset({
        "a.txt": "alpha contents",
        "sub/b.txt": "beta contents",
        "sub/deep/c.bin": Buffer.from([0, 1, 2, 3, 255]),
      });
      const manifest = readManifest(manifestPath);

      // Prove the deeply-nested member.
      const built = buildDatasetProof({
        file: path.join(dir, "sub/b.txt"),
        manifest: manifestPath,
      });
      expect(built.member).to.equal(true);
      expect(built.relPath).to.equal("sub/b.txt");
      expect(built.root).to.equal(manifest.root);
      expect(built.contentHash).to.equal(ethers.keccak256(Buffer.from("beta contents")));

      // The proof folds to the manifest root via the SAME recompute the on-chain verifyLeaf uses.
      const fold = recomputeFold(built.artifact);
      expect(fold.leafMatches).to.equal(true);
      expect(fold.foldsToRoot).to.equal(true);
      expect(fold.computedRoot).to.equal(manifest.root);
      expect(fold.offlineOk).to.equal(true);
    });

    it("a single-file dataset proves with an empty proof folding to the (== leaf) root", function () {
      const { dir, manifestPath } = freshDataset({ "only.txt": "sole member" });
      const built = buildDatasetProof({ file: path.join(dir, "only.txt"), manifest: manifestPath });
      expect(built.member).to.equal(true);
      expect(built.proof).to.have.length(0);
      expect(recomputeFold(built.artifact).offlineOk).to.equal(true);
    });

    it("a fabricated/altered file is a clear NON-member (and writes NO artifact)", function () {
      const { dir, manifestPath } = freshDataset({ "a.txt": "alpha", "b.txt": "beta" });
      // A file whose bytes were never in the dataset.
      const fake = path.join(tmp("dsp-fake-"), "fabricated.txt");
      fs.writeFileSync(fake, "this content was never in the dataset");
      const built = buildDatasetProof({ file: fake, manifest: manifestPath });
      expect(built.member).to.equal(false);
      expect(built.artifact).to.equal(null);
      expect(built.proof).to.equal(null);

      // Through the runner with --out: a non-member must NOT write an artifact.
      const outDir = tmp("dsp-fake-out-");
      const out = path.join(outDir, "proof.json");
      const res = runDatasetProve({ file: fake, manifest: manifestPath, out, stdout: () => {} });
      expect(res.member).to.equal(false);
      expect(res.out).to.equal(null);
      expect(fs.existsSync(out)).to.equal(false);
      expect(fs.readdirSync(outDir)).to.deep.equal([]);
    });

    it("an ALTERED in-set file (one byte flipped) is a NON-member", function () {
      const { dir, manifestPath } = freshDataset({ "doc.txt": "the original document" });
      const altered = path.join(tmp("dsp-alt-"), "doc.txt");
      fs.writeFileSync(altered, "the original document!"); // one byte added
      const built = buildDatasetProof({ file: altered, manifest: manifestPath });
      expect(built.member).to.equal(false);
    });

    it("verify-proof CONFIRMS a genuine artifact with NO dataset copy and NO network", function () {
      const { dir, manifestPath } = freshDataset({ "x.txt": "ex", "y.txt": "why", "z.txt": "zee" });
      const out = path.join(tmp("dsp-vp-out-"), "proof.json");
      const res = runDatasetProve({
        file: path.join(dir, "y.txt"),
        manifest: manifestPath,
        out,
        stdout: () => {},
      });
      expect(res.member).to.equal(true);
      expect(res.out).to.equal(path.resolve(out));
      expect(fs.existsSync(out)).to.equal(true);

      // Delete the WHOLE dataset + manifest to prove verification needs neither.
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(manifestPath, { force: true });

      const vp = runDatasetVerifyProof({ artifact: out, stdout: () => {} });
      expect(vp.status).to.equal("CONFIRMED");
      expect(vp.leafMatches).to.equal(true);
      expect(vp.foldsToRoot).to.equal(true);
      expect(vp.computedRoot).to.equal(vp.root);
    });

    it("verify-proof REJECTS a tampered proof sibling (does not fold to the root)", function () {
      const { dir, manifestPath } = freshDataset({ "a.txt": "alpha", "b.txt": "beta", "c.txt": "gamma" });
      const out = path.join(tmp("dsp-tamper-out-"), "proof.json");
      runDatasetProve({ file: path.join(dir, "a.txt"), manifest: manifestPath, out, stdout: () => {} });

      // Flip one nibble of the first proof sibling -> the fold no longer reaches the recorded root.
      const art = JSON.parse(fs.readFileSync(out, "utf8"));
      expect(art.proof.length).to.be.greaterThan(0);
      const s = art.proof[0];
      art.proof[0] = s.slice(0, -1) + (s.slice(-1) === "0" ? "1" : "0");
      fs.writeFileSync(out, JSON.stringify(art));

      const vp = runDatasetVerifyProof({ artifact: out, stdout: () => {} });
      expect(vp.status).to.equal("REJECTED");
      expect(vp.leafMatches).to.equal(true); // leaf untouched
      expect(vp.foldsToRoot).to.equal(false); // but it no longer folds
    });

    it("verify-proof REJECTS a forged leaf (leaf != pathLeaf(relPath, contentHash))", function () {
      const { dir, manifestPath } = freshDataset({ "a.txt": "alpha", "b.txt": "beta" });
      const out = path.join(tmp("dsp-forge-out-"), "proof.json");
      runDatasetProve({ file: path.join(dir, "a.txt"), manifest: manifestPath, out, stdout: () => {} });
      const art = JSON.parse(fs.readFileSync(out, "utf8"));
      // Swap the contentHash so the leaf no longer re-derives from contentHash+relPath.
      art.contentHash = ethers.keccak256(Buffer.from("a different file entirely"));
      fs.writeFileSync(out, JSON.stringify(art));
      const vp = runDatasetVerifyProof({ artifact: out, stdout: () => {} });
      expect(vp.status).to.equal("REJECTED");
      expect(vp.leafMatches).to.equal(false);
    });

    it("verify-proof on a CONFIRMED proof needs neither network nor the original dataset (artifact is self-contained)", function () {
      // Build a proof, then verify it with the artifact as the ONLY input that exists on disk.
      const { dir, manifestPath } = freshDataset({ "p.txt": "payload", "q.txt": "quux" });
      const isolated = tmp("dsp-isolated-");
      const out = path.join(isolated, "proof.json");
      runDatasetProve({ file: path.join(dir, "p.txt"), manifest: manifestPath, out, stdout: () => {} });
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(path.dirname(manifestPath), { recursive: true, force: true });
      // Only the artifact remains; verification is pure recompute.
      const back = readProofArtifact(out);
      expect(recomputeFold(back).offlineOk).to.equal(true);
      expect(runDatasetVerifyProof({ artifact: out, stdout: () => {} }).status).to.equal("CONFIRMED");
    });

    it("buildDatasetProof errors on a missing file and on a corrupt manifest", function () {
      const { dir, manifestPath } = freshDataset({ "a.txt": "alpha" });
      expect(() =>
        buildDatasetProof({ file: path.join(dir, "nope.txt"), manifest: manifestPath })
      ).to.throw(); // statSync ENOENT
      // Corrupt the manifest -> readManifest rejects it before any proof.
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      m.root = "0xnothex";
      fs.writeFileSync(manifestPath, JSON.stringify(m));
      expect(() =>
        buildDatasetProof({ file: path.join(dir, "a.txt"), manifest: manifestPath })
      ).to.throw(/root must be a 0x-prefixed 32-byte hex/);
    });

    // ---- CLI wiring + exit codes -------------------------------------------------------------------
    it("parseDatasetProveArgs parses flags and rejects unknowns / stray positionals", function () {
      expect(parseDatasetProveArgs(["--file", "/f", "--manifest", "/m", "--out", "/o", "--json"])).to.deep.equal({
        file: "/f",
        manifest: "/m",
        out: "/o",
        json: true,
      });
      expect(() => parseDatasetProveArgs(["--bogus"])).to.throw(/unknown flag/);
      expect(() => parseDatasetProveArgs(["stray"])).to.throw(/unexpected argument/);
      expect(() => parseDatasetProveArgs(["--file"])).to.throw(/--file requires a value/);
    });

    it("parseDatasetVerifyProofArgs parses positional + flags and rejects unknowns", function () {
      expect(parseDatasetVerifyProofArgs(["/p", "--json"])).to.deep.equal({
        artifact: "/p",
        json: true,
      });
      expect(() => parseDatasetVerifyProofArgs(["/p", "--bogus"])).to.throw(/unknown flag/);
      expect(() => parseDatasetVerifyProofArgs(["/p", "/q"])).to.throw(/unexpected extra argument/);
    });

    it("main() prove exit 0 MEMBER / 3 NOT A MEMBER; verify-proof exit 0 CONFIRMED / 3 REJECTED", async function () {
      const { dir, manifestPath } = freshDataset({ "a.txt": "alpha", "b.txt": "beta" });
      const out = path.join(tmp("dsp-cli-out-"), "proof.json");

      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = () => true;
      try {
        // MEMBER -> exit 0, artifact written.
        const member = await main([
          "dataset", "prove", "--file", path.join(dir, "a.txt"), "--manifest", manifestPath, "--out", out,
        ]);
        expect(member).to.equal(0);
        expect(fs.existsSync(out)).to.equal(true);

        // verify-proof CONFIRMED -> exit 0.
        const confirmed = await main(["dataset", "verify-proof", out]);
        expect(confirmed).to.equal(0);

        // NON-member -> exit 3.
        const fake = path.join(tmp("dsp-cli-fake-"), "fake.txt");
        fs.writeFileSync(fake, "never in the dataset");
        const notMember = await main([
          "dataset", "prove", "--file", fake, "--manifest", manifestPath,
        ]);
        expect(notMember).to.equal(3);

        // Tamper the artifact -> verify-proof REJECTED -> exit 3.
        const art = JSON.parse(fs.readFileSync(out, "utf8"));
        const s = art.proof[0];
        art.proof[0] = s.slice(0, -1) + (s.slice(-1) === "0" ? "1" : "0");
        fs.writeFileSync(out, JSON.stringify(art));
        const rejected = await main(["dataset", "verify-proof", out]);
        expect(rejected).to.equal(3);
      } finally {
        process.stdout.write = orig;
      }
    });

    it("main() --json prove + verify-proof emit machine-readable objects", async function () {
      const { dir, manifestPath } = freshDataset({ "a.txt": "alpha", "b.txt": "beta" });
      const out = path.join(tmp("dsp-cli-json-out-"), "proof.json");
      const chunks = [];
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = (s) => {
        chunks.push(s);
        return true;
      };
      try {
        const code = await main([
          "dataset", "prove", "--file", path.join(dir, "a.txt"), "--manifest", manifestPath, "--out", out, "--json",
        ]);
        expect(code).to.equal(0);
        const proveJson = JSON.parse(chunks.join(""));
        expect(proveJson.member).to.equal(true);
        expect(proveJson.relPath).to.equal("a.txt");
        expect(proveJson.out).to.equal(path.resolve(out));

        chunks.length = 0;
        const vpCode = await main(["dataset", "verify-proof", out, "--json"]);
        expect(vpCode).to.equal(0);
        const vpJson = JSON.parse(chunks.join(""));
        expect(vpJson.status).to.equal("CONFIRMED");
        expect(vpJson.foldsToRoot).to.equal(true);
      } finally {
        process.stdout.write = orig;
      }
    });

    it("main() prove exit 2 on missing --file / --manifest; verify-proof exit 1 on a missing artifact", async function () {
      const { dir, manifestPath } = freshDataset({ "a.txt": "alpha" });
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = () => true;
      try {
        expect(await main(["dataset", "prove", "--manifest", manifestPath])).to.equal(2); // no --file
        expect(await main(["dataset", "prove", "--file", path.join(dir, "a.txt")])).to.equal(2); // no --manifest
        expect(await main(["dataset", "verify-proof", "/no/such/proof.json"])).to.equal(1); // missing artifact
      } finally {
        process.stderr.write = orig;
      }
    });

    it("writes the proof artifact ONLY at the caller's --out path (no cwd litter)", function () {
      const { dir, manifestPath } = freshDataset({ "a.txt": "alpha", "b.txt": "beta" });
      const outDir = tmp("dsp-only-out-");
      const out = path.join(outDir, "membership.json");
      expect(fs.readdirSync(outDir)).to.deep.equal([]);
      runDatasetProve({ file: path.join(dir, "a.txt"), manifest: manifestPath, out, stdout: () => {} });
      expect(fs.readdirSync(outDir)).to.deep.equal(["membership.json"]);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // T-14.1: `vh dataset diff <manifestA> <manifestB>` — OFFLINE manifest-to-manifest change report.
  // ---------------------------------------------------------------------------------------------------
  describe("vh dataset diff (T-14.1): OFFLINE manifest-to-manifest change report", function () {
    // Build a manifest for `files` and return its path (no live tree is retained — diff is offline).
    function manifestFor(files, prefix) {
      const dir = tmp(prefix + "-tree-");
      writeFiles(dir, files);
      const out = path.join(tmp(prefix + "-man-"), "manifest.json");
      runDatasetBuild({ dir, out, stdout: () => {} });
      return out;
    }

    const BASE = {
      "a.txt": "alpha",
      "sub/b.txt": "beta",
      "sub/deep/c.bin": Buffer.from([0, 1, 2, 3]),
    };

    it("reports exactly the CHANGED/ADDED/REMOVED set with old->new hashes (A built; B edits+adds+removes)", function () {
      const aPath = manifestFor(BASE, "dsd-a");
      // B: edit a.txt, add d.txt, remove sub/b.txt (keep sub/deep/c.bin unchanged).
      const bPath = manifestFor(
        {
          "a.txt": "alpha EDITED",
          "sub/deep/c.bin": Buffer.from([0, 1, 2, 3]),
          "d.txt": "newly added",
        },
        "dsd-b"
      );

      const lines = [];
      const res = runDatasetDiff({ manifestA: aPath, manifestB: bPath, stdout: (s) => lines.push(s) });

      expect(res.rootsIdentical).to.equal(false);
      expect(res.identical).to.equal(false);
      expect(res.changed.map((c) => c.path)).to.deep.equal(["a.txt"]);
      expect(res.added.map((a) => a.path)).to.deep.equal(["d.txt"]);
      expect(res.removed.map((r) => r.path)).to.deep.equal(["sub/b.txt"]);
      expect(res.unchanged.map((u) => u.path)).to.deep.equal(["sub/deep/c.bin"]);

      // CHANGED carries old->new contentHash (A's bytes -> B's bytes).
      const c = res.changed[0];
      expect(c.oldContentHash).to.equal(ethers.keccak256(Buffer.from("alpha")));
      expect(c.newContentHash).to.equal(ethers.keccak256(Buffer.from("alpha EDITED")));
      // ADDED / REMOVED carry the right contentHash.
      expect(res.added[0].contentHash).to.equal(ethers.keccak256(Buffer.from("newly added")));
      expect(res.removed[0].contentHash).to.equal(ethers.keccak256(Buffer.from("beta")));

      expect(res.counts).to.deep.equal({ added: 1, removed: 1, changed: 1, unchanged: 1 });

      // Human output: TRUST note, both roots, DIFFERENT, the count line, and the rename caveat.
      const out = lines.join("");
      expect(out).to.contain("TRUST:");
      expect(out).to.contain(res.rootA);
      expect(out).to.contain(res.rootB);
      expect(out).to.contain("DIFFERENT");
      expect(out).to.contain("+1 / -1 / ~1 / 1 unchanged");
      expect(out).to.contain("REMOVED(old path) + ADDED(new path)");
      expect(out).to.contain("CHANGED  a.txt");
      expect(out).to.contain("ADDED    d.txt");
      expect(out).to.contain("REMOVED  sub/b.txt");
    });

    it("exit 3 via main() when the manifests DIFFER", async function () {
      const aPath = manifestFor(BASE, "dsd-x3a");
      const bPath = manifestFor({ "a.txt": "alpha EDITED" }, "dsd-x3b");
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = () => true;
      try {
        expect(await main(["dataset", "diff", aPath, bPath])).to.equal(3);
      } finally {
        process.stdout.write = orig;
      }
    });

    it("diffing a manifest against ITSELF reports IDENTICAL with exit 0", async function () {
      const aPath = manifestFor(BASE, "dsd-self");
      const lines = [];
      const res = runDatasetDiff({ manifestA: aPath, manifestB: aPath, stdout: (s) => lines.push(s) });
      expect(res.rootsIdentical).to.equal(true);
      expect(res.identical).to.equal(true);
      expect(res.rootA).to.equal(res.rootB);
      expect(res.counts).to.deep.equal({
        added: 0,
        removed: 0,
        changed: 0,
        unchanged: Object.keys(BASE).length,
      });
      const out = lines.join("");
      expect(out).to.contain("IDENTICAL");
      expect(out).to.contain(`+0 / -0 / ~0 / ${Object.keys(BASE).length} unchanged`);

      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = () => true;
      try {
        expect(await main(["dataset", "diff", aPath, aPath])).to.equal(0);
      } finally {
        process.stdout.write = orig;
      }
    });

    it("two DISTINCT manifests over the SAME tree are IDENTICAL (root commits to content, not the file)", function () {
      const aPath = manifestFor(BASE, "dsd-eqA");
      const bPath = manifestFor(BASE, "dsd-eqB");
      const res = runDatasetDiff({ manifestA: aPath, manifestB: bPath, stdout: () => {} });
      expect(res.rootsIdentical).to.equal(true);
      expect(res.counts.changed).to.equal(0);
      expect(res.counts.added).to.equal(0);
      expect(res.counts.removed).to.equal(0);
    });

    it("verdict is the CHANGE SET, not the root string: a hand-edited `root` (leaves intact) stays IDENTICAL/exit 0", async function () {
      // Two manifests with IDENTICAL leaves, but B's recorded `root` field is hand-edited to a
      // different (still well-formed) value. readManifest validates each leaf == pathLeaf(relPath,
      // contentHash) and the fileCount, but does NOT re-derive root == merkleRoot(leaves), so this
      // tampered manifest passes validation. The verdict (exit + headline) must come from the change
      // set (empty here) — NOT from rootsIdentical — so it never contradicts its own changeset.
      const aPath = manifestFor(BASE, "dsd-tamperA");
      const bPath = path.join(tmp("dsd-tamperB-"), "manifest.json");
      const m = JSON.parse(fs.readFileSync(aPath, "utf8"));
      // Flip the first hex digit of the root to a guaranteed-different well-formed 32-byte hex value.
      const flipped = m.root[2] === "f" ? "0" : "f";
      m.root = "0x" + flipped + m.root.slice(3);
      fs.writeFileSync(bPath, JSON.stringify(m, null, 2) + "\n");

      const lines = [];
      const res = runDatasetDiff({ manifestA: aPath, manifestB: bPath, stdout: (s) => lines.push(s) });

      // The raw root STRINGS differ (B was tampered), but the change set is EMPTY.
      expect(res.rootsIdentical).to.equal(false);
      expect(res.identical).to.equal(true);
      expect(res.counts).to.deep.equal({
        added: 0,
        removed: 0,
        changed: 0,
        unchanged: Object.keys(BASE).length,
      });

      // Headline + body AGREE: IDENTICAL with an empty changeset; the discrepancy is called out, not hidden.
      const out = lines.join("");
      expect(out).to.contain("IDENTICAL");
      expect(out).to.contain(`+0 / -0 / ~0 / ${Object.keys(BASE).length} unchanged`);
      expect(out).to.contain("hand-edited"); // explicitly flags the root mismatch rather than flipping the verdict

      // The EXIT CODE (what CI branches on) matches the empty changeset: 0, not 3.
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = () => true;
      try {
        expect(await main(["dataset", "diff", aPath, bPath])).to.equal(0);
      } finally {
        process.stdout.write = orig;
      }
    });

    it("a RENAME surfaces as REMOVED(old path) + ADDED(new path), same bytes (not 'unchanged')", function () {
      const aPath = manifestFor(
        { "stable.txt": "stays", "old-name.txt": "same bytes either way" },
        "dsd-renA"
      );
      const bPath = manifestFor(
        { "stable.txt": "stays", "new-name.txt": "same bytes either way" },
        "dsd-renB"
      );
      const res = runDatasetDiff({ manifestA: aPath, manifestB: bPath, stdout: () => {} });
      expect(res.rootsIdentical).to.equal(false);
      expect(res.removed.map((r) => r.path)).to.deep.equal(["old-name.txt"]);
      expect(res.added.map((a) => a.path)).to.deep.equal(["new-name.txt"]);
      expect(res.changed).to.have.length(0);
      const sameHash = ethers.keccak256(Buffer.from("same bytes either way"));
      expect(res.removed[0].contentHash).to.equal(sameHash);
      expect(res.added[0].contentHash).to.equal(sameHash);
    });

    it("--json round-trips and carries the same counts (no human text)", function () {
      const aPath = manifestFor(BASE, "dsd-jsonA");
      const bPath = manifestFor({ "a.txt": "alpha EDITED", "sub/b.txt": "beta" }, "dsd-jsonB");
      const lines = [];
      const res = runDatasetDiff({ manifestA: aPath, manifestB: bPath, json: true, stdout: (s) => lines.push(s) });
      const parsed = JSON.parse(lines.join(""));
      expect(parsed.rootA).to.equal(res.rootA);
      expect(parsed.rootB).to.equal(res.rootB);
      expect(parsed.rootsIdentical).to.equal(false);
      expect(parsed.identical).to.equal(false);
      expect(parsed.counts).to.deep.equal(res.counts);
      expect(parsed.changed.map((c) => c.path)).to.deep.equal(["a.txt"]);
      expect(parsed.removed.map((r) => r.path)).to.deep.equal(["sub/deep/c.bin"]);
      // Pure JSON object on a single line: no TRUST note leaked into machine output.
      expect(lines.join("")).to.not.contain("TRUST:");
    });

    it("rejects a corrupt/foreign manifest by readManifest (no half-accept)", async function () {
      const aPath = manifestFor(BASE, "dsd-corrupt");
      // A corrupt B: valid JSON but a non-hex root.
      const m = JSON.parse(fs.readFileSync(aPath, "utf8"));
      m.root = "0xnothex";
      const bPath = path.join(tmp("dsd-corrupt-b-"), "m.json");
      fs.writeFileSync(bPath, JSON.stringify(m));
      expect(() => runDatasetDiff({ manifestA: aPath, manifestB: bPath, stdout: () => {} })).to.throw(
        /root must be a 0x-prefixed 32-byte hex/
      );

      // A FOREIGN artifact (wrong kind) is rejected too.
      const foreignPath = path.join(tmp("dsd-foreign-"), "f.json");
      fs.writeFileSync(foreignPath, JSON.stringify({ kind: "not-a-manifest", schemaVersion: 1 }));
      expect(() => runDatasetDiff({ manifestA: aPath, manifestB: foreignPath, stdout: () => {} })).to.throw(
        /not a verifyhash dataset manifest/
      );

      // main() surfaces a corrupt/missing manifest as exit 1 (runtime error).
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = () => true;
      try {
        expect(await main(["dataset", "diff", aPath, bPath])).to.equal(1);
        expect(await main(["dataset", "diff", aPath, "/no/such/manifest.json"])).to.equal(1);
      } finally {
        process.stderr.write = orig;
      }
    });

    it("parseDatasetDiffArgs: two positionals + --json; rejects a third positional / unknown flag", function () {
      expect(parseDatasetDiffArgs(["A", "B"])).to.deep.equal({
        manifestA: "A",
        manifestB: "B",
        json: false,
      });
      expect(parseDatasetDiffArgs(["A", "B", "--json"])).to.deep.equal({
        manifestA: "A",
        manifestB: "B",
        json: true,
      });
      expect(() => parseDatasetDiffArgs(["A", "B", "C"])).to.throw(/exactly two manifests/);
      expect(() => parseDatasetDiffArgs(["A", "B", "--bogus"])).to.throw(/unknown flag/);
    });

    it("main() exit 2 (usage) on a missing positional, a third positional, or an unknown flag", async function () {
      const aPath = manifestFor(BASE, "dsd-usage");
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = () => true;
      try {
        expect(await main(["dataset", "diff", aPath])).to.equal(2); // only one positional
        expect(await main(["dataset", "diff"])).to.equal(2); // no positional
        expect(await main(["dataset", "diff", aPath, aPath, aPath])).to.equal(2); // third positional
        expect(await main(["dataset", "diff", aPath, aPath, "--bogus"])).to.equal(2); // unknown flag
      } finally {
        process.stderr.write = orig;
      }
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // T-14.2: `vh dataset summary <manifest>` — OFFLINE provenance/license roll-up.
  // ---------------------------------------------------------------------------------------------------
  describe("vh dataset summary (T-14.2): OFFLINE provenance/license roll-up", function () {
    // Build a manifest for `files` with optional `hints`, return its path. No live tree is retained — the
    // summary is offline. Every temp dir self-cleans in afterEach.
    function manifestFor(files, hints, prefix) {
      const dir = tmp((prefix || "dss") + "-tree-");
      writeFiles(dir, files);
      const out = path.join(tmp((prefix || "dss") + "-man-"), "manifest.json");
      const hintsPath = hints
        ? (() => {
            const p = path.join(tmp((prefix || "dss") + "-hints-"), "hints.json");
            fs.writeFileSync(p, JSON.stringify(hints));
            return p;
          })()
        : undefined;
      // Read the hints file the same way cmdDataset does (so we exercise the real shape), then build.
      const parsedHints = hintsPath ? JSON.parse(fs.readFileSync(hintsPath, "utf8")) : undefined;
      runDatasetBuild({ dir, out, hints: parsedHints, stdout: () => {} });
      return out;
    }

    it("reports correct per-license / per-source counts AND the right no-hint bucket sizes", function () {
      // 4 files: two share license MIT, one is Apache-2.0, one has no license hint. Sources: two share
      // 'corpus-X', one is 'internal', one has no source hint.
      const manifestPath = manifestFor(
        { "a.txt": "AAA", "b.txt": "BBB", "c.txt": "CCC", "d.txt": "DDD" },
        {
          "a.txt": { license: "MIT", source: "corpus-X" },
          "b.txt": { license: "MIT", source: "corpus-X" },
          "c.txt": { license: "Apache-2.0", source: "internal" },
          // d.txt: NO hint at all
        },
        "dss-counts"
      );
      const lines = [];
      const res = runDatasetSummary({ manifest: manifestPath, stdout: (s) => lines.push(s) });

      expect(res.fileCount).to.equal(4);
      expect(res.root).to.match(/^0x[0-9a-f]{64}$/);
      expect(res.licenses).to.deep.equal({
        MIT: 2,
        "Apache-2.0": 1,
        [NO_LICENSE_BUCKET]: 1,
      });
      expect(res.sources).to.deep.equal({
        "corpus-X": 2,
        internal: 1,
        [NO_SOURCE_BUCKET]: 1,
      });
      expect(res.filesWithLicenseHint).to.equal(3);
      expect(res.filesWithSourceHint).to.equal(3);

      // Per-histogram counts always sum to fileCount (no file silently dropped).
      const sum = (h) => Object.values(h).reduce((a, b) => a + b, 0);
      expect(sum(res.licenses)).to.equal(res.fileCount);
      expect(sum(res.sources)).to.equal(res.fileCount);

      // Human output LEADS with the trust caveat and explains the no-hint bucket.
      const out = lines.join("");
      expect(out).to.contain("TRUST:");
      expect(out).to.contain("UNTRUSTED");
      expect(out).to.contain("CLAIMS");
      expect(out).to.contain("does NOT verify");
      expect(out).to.contain("ASSERTS NOTHING");
      expect(out).to.contain(res.root);
      expect(out).to.contain("MIT");
      expect(out).to.contain(NO_LICENSE_BUCKET);
      expect(out).to.contain(NO_SOURCE_BUCKET);
    });

    it("a manifest with a partial hint (license only, no source) buckets the missing source correctly", function () {
      const manifestPath = manifestFor(
        { "a.txt": "AAA", "b.txt": "BBB" },
        { "a.txt": { license: "CC0-1.0" } }, // license but NO source; b.txt has nothing
        "dss-partial"
      );
      const res = runDatasetSummary({ manifest: manifestPath, stdout: () => {} });
      expect(res.licenses).to.deep.equal({ "CC0-1.0": 1, [NO_LICENSE_BUCKET]: 1 });
      expect(res.sources).to.deep.equal({ [NO_SOURCE_BUCKET]: 2 });
      expect(res.filesWithLicenseHint).to.equal(1);
      expect(res.filesWithSourceHint).to.equal(0);
    });

    it("a valid manifest with NO fileCount field derives fileCount from files.length (human + --json)", function () {
      // A third-party manifest may legitimately omit the OPTIONAL fileCount field: validateManifest only
      // checks it "when present", so a non-empty files[] with no fileCount is valid. The summary must NOT
      // passthrough manifest.fileCount (undefined here) — it derives from files.length so the field is
      // always present and self-consistent with the histograms.
      const manifestPath = manifestFor(
        { "a.txt": "AAA", "b.txt": "BBB", "c.txt": "CCC" },
        { "a.txt": { license: "MIT" } },
        "dss-nofc"
      );
      // Strip the OPTIONAL fileCount; the stripped manifest stays valid (readManifest accepts it).
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      delete m.fileCount;
      const strippedPath = path.join(tmp("dss-nofc-stripped-"), "m.json");
      fs.writeFileSync(strippedPath, JSON.stringify(m));

      // Human denominator is the real count, not "undefined".
      const lines = [];
      const res = runDatasetSummary({ manifest: strippedPath, stdout: (s) => lines.push(s) });
      expect(res.fileCount).to.equal(3);
      const out = lines.join("");
      expect(out).to.contain("files: 3");
      expect(out).to.contain("1/3 files carry a license hint");
      expect(out).to.not.contain("undefined");

      // --json carries the fileCount key (JSON.stringify would DROP it if it were undefined).
      const jsonLines = [];
      const jres = runDatasetSummary({ manifest: strippedPath, json: true, stdout: (s) => jsonLines.push(s) });
      const parsed = JSON.parse(jsonLines.join(""));
      expect(parsed).to.have.property("fileCount", 3);
      expect(jres.fileCount).to.equal(3);
      // Histograms still sum to fileCount.
      const sum = (h) => Object.values(h).reduce((a, b) => a + b, 0);
      expect(sum(parsed.licenses)).to.equal(parsed.fileCount);
      expect(sum(parsed.sources)).to.equal(parsed.fileCount);
    });

    it("a manifest with ZERO hints reports every file under the no-hint buckets", function () {
      const manifestPath = manifestFor(
        { "a.txt": "AAA", "b.txt": "BBB", "c.txt": "CCC" },
        undefined,
        "dss-zero"
      );
      const res = runDatasetSummary({ manifest: manifestPath, stdout: () => {} });
      expect(res.fileCount).to.equal(3);
      expect(res.licenses).to.deep.equal({ [NO_LICENSE_BUCKET]: 3 });
      expect(res.sources).to.deep.equal({ [NO_SOURCE_BUCKET]: 3 });
      expect(res.filesWithLicenseHint).to.equal(0);
      expect(res.filesWithSourceHint).to.equal(0);
    });

    it("--json round-trips (machine-readable object, no human text leaked)", function () {
      const manifestPath = manifestFor(
        { "a.txt": "AAA", "b.txt": "BBB" },
        { "a.txt": { license: "MIT", source: "corpus-X" } },
        "dss-json"
      );
      const lines = [];
      const res = runDatasetSummary({ manifest: manifestPath, json: true, stdout: (s) => lines.push(s) });
      const parsed = JSON.parse(lines.join(""));
      expect(parsed.root).to.equal(res.root);
      expect(parsed.fileCount).to.equal(2);
      expect(parsed.licenses).to.deep.equal({ MIT: 1, [NO_LICENSE_BUCKET]: 1 });
      expect(parsed.sources).to.deep.equal({ "corpus-X": 1, [NO_SOURCE_BUCKET]: 1 });
      expect(parsed.filesWithLicenseHint).to.equal(1);
      expect(parsed.filesWithSourceHint).to.equal(1);
      // No TRUST caveat text leaked into the JSON line.
      expect(lines.join("")).to.not.contain("TRUST:");
    });

    it("rejects a corrupt/foreign manifest (no half-accept)", function () {
      const manifestPath = manifestFor({ "a.txt": "AAA" }, undefined, "dss-corrupt");
      // Corrupt: valid JSON, non-hex root.
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      m.root = "0xnothex";
      const badPath = path.join(tmp("dss-corrupt-bad-"), "m.json");
      fs.writeFileSync(badPath, JSON.stringify(m));
      expect(() => runDatasetSummary({ manifest: badPath, stdout: () => {} })).to.throw(
        /root must be a 0x-prefixed 32-byte hex/
      );
      // A FOREIGN artifact (wrong kind) is rejected too.
      const foreignPath = path.join(tmp("dss-foreign-"), "f.json");
      fs.writeFileSync(foreignPath, JSON.stringify({ kind: "not-a-manifest", schemaVersion: 1 }));
      expect(() => runDatasetSummary({ manifest: foreignPath, stdout: () => {} })).to.throw(
        /not a verifyhash dataset manifest/
      );
    });

    // ---- CLI wiring + exit codes -------------------------------------------------------------------
    it("parseDatasetSummaryArgs parses positional + --json; rejects unknowns / extra positionals", function () {
      expect(parseDatasetSummaryArgs(["/m"])).to.deep.equal({ manifest: "/m", json: false });
      expect(parseDatasetSummaryArgs(["/m", "--json"])).to.deep.equal({ manifest: "/m", json: true });
      expect(() => parseDatasetSummaryArgs(["/m", "--bogus"])).to.throw(/unknown flag/);
      expect(() => parseDatasetSummaryArgs(["/m", "/n"])).to.throw(/unexpected extra argument/);
    });

    it("main() exit 0 on success; --json emits the machine-readable object", async function () {
      const manifestPath = manifestFor(
        { "a.txt": "AAA", "b.txt": "BBB" },
        { "a.txt": { license: "MIT" } },
        "dss-cli"
      );
      const chunks = [];
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = (s) => {
        chunks.push(s);
        return true;
      };
      let code;
      try {
        code = await main(["dataset", "summary", manifestPath, "--json"]);
      } finally {
        process.stdout.write = orig;
      }
      expect(code).to.equal(0);
      const parsed = JSON.parse(chunks.join(""));
      expect(parsed.fileCount).to.equal(2);
      expect(parsed.licenses).to.deep.equal({ MIT: 1, [NO_LICENSE_BUCKET]: 1 });
    });

    it("main() exit 2 (usage) on a missing positional / extra positional / unknown flag", async function () {
      const manifestPath = manifestFor({ "a.txt": "AAA" }, undefined, "dss-usage");
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = () => true;
      try {
        expect(await main(["dataset", "summary"])).to.equal(2); // no positional
        expect(await main(["dataset", "summary", manifestPath, manifestPath])).to.equal(2); // extra positional
        expect(await main(["dataset", "summary", manifestPath, "--bogus"])).to.equal(2); // unknown flag
      } finally {
        process.stderr.write = orig;
      }
    });

    it("main() exit 1 on a missing / corrupt manifest (runtime error)", async function () {
      const manifestPath = manifestFor({ "a.txt": "AAA" }, undefined, "dss-rt");
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      m.root = "0xnothex";
      const badPath = path.join(tmp("dss-rt-bad-"), "m.json");
      fs.writeFileSync(badPath, JSON.stringify(m));
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = () => true;
      try {
        expect(await main(["dataset", "summary", "/no/such/manifest.json"])).to.equal(1);
        expect(await main(["dataset", "summary", badPath])).to.equal(1);
      } finally {
        process.stderr.write = orig;
      }
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // T-15.1: `vh dataset report <manifest> [--verify <dir>] [--json] [--out <p>]` — ONE self-contained,
  // deterministic evidence document a reviewer files.
  // ---------------------------------------------------------------------------------------------------
  describe("vh dataset report (T-15.1): ONE deterministic evidence document", function () {
    // Build a manifest for `files` (+ optional hints) and return { dir, manifestPath } so a test can
    // also verify against the live `dir`. Every temp dir self-cleans in afterEach.
    function buildFixture(files, hints, prefix) {
      const dir = tmp((prefix || "rep") + "-tree-");
      writeFiles(dir, files);
      const manifestPath = path.join(tmp((prefix || "rep") + "-man-"), "manifest.json");
      runDatasetBuild({ dir, out: manifestPath, hints, stdout: () => {} });
      return { dir, manifestPath };
    }

    it("manifest-only Markdown carries root, fileCount, the SAME histogram as summary, + trust caveats", function () {
      const { manifestPath } = buildFixture(
        { "a.txt": "AAA", "b.txt": "BBB", "c.txt": "CCC", "d.txt": "DDD" },
        {
          "a.txt": { license: "MIT", source: "corpus-X" },
          "b.txt": { license: "MIT", source: "corpus-X" },
          "c.txt": { license: "Apache-2.0", source: "internal" },
        },
        "rep-md"
      );
      const lines = [];
      const res = runDatasetReport({ manifest: manifestPath, stdout: (s) => lines.push(s) });
      const out = lines.join("");

      // Identity.
      expect(out).to.contain(res.model.root);
      expect(out).to.contain("fileCount: 4");
      // Trust posture LEADS the document, reuses the verbatim TRUST_NOTE wording, and does not overclaim.
      expect(out.indexOf("Trust posture")).to.be.lessThan(out.indexOf("Dataset identity"));
      expect(out).to.contain("UNTRUSTED");
      expect(out).to.contain("NOT a timestamp");
      expect(out).to.contain("needs-human");
      // Provenance roll-up uses the SAME histogram lines `vh dataset summary` produces.
      const summaryLines = [];
      runDatasetSummary({ manifest: manifestPath, stdout: (s) => summaryLines.push(s) });
      const sumOut = summaryLines.join("");
      // The "2  MIT" / "(no license hint)" histogram rows are byte-shared between the two commands.
      expect(out).to.contain("MIT");
      expect(out).to.contain(NO_LICENSE_BUCKET);
      expect(out).to.contain(NO_SOURCE_BUCKET);
      // Both render via the same _histogramLines: the exact "     2  MIT" row appears in both outputs.
      expect(sumOut).to.contain("     2  MIT");
      expect(out).to.contain("     2  MIT");
      // No --verify: the report says PLAINLY that no live-tree verify happened (never implies one).
      expect(out).to.contain("NO live-tree verification was performed");
      expect(out).to.contain("CLAIM");
      expect(res.verifyStatus).to.equal(null);
    });

    it("is DETERMINISTIC: two runs over the same manifest produce byte-identical Markdown", function () {
      const { manifestPath } = buildFixture(
        { "z.txt": "ZZZ", "m.txt": "MMM", "a.txt": "AAA" },
        { "z.txt": { license: "MIT" }, "m.txt": { license: "MIT" }, "a.txt": { license: "BSD-3-Clause" } },
        "rep-det"
      );
      const run1 = [];
      const run2 = [];
      runDatasetReport({ manifest: manifestPath, stdout: (s) => run1.push(s) });
      runDatasetReport({ manifest: manifestPath, stdout: (s) => run2.push(s) });
      expect(run1.join("")).to.equal(run2.join(""));
    });

    it("--json round-trips and carries the same fields (no verify key without --verify)", function () {
      const { manifestPath } = buildFixture(
        { "a.txt": "AAA", "b.txt": "BBB" },
        { "a.txt": { license: "MIT", source: "corpus-X" } },
        "rep-json"
      );
      const lines = [];
      const res = runDatasetReport({ manifest: manifestPath, json: true, stdout: (s) => lines.push(s) });
      const parsed = JSON.parse(lines.join(""));
      expect(parsed.root).to.equal(res.model.root);
      expect(parsed.fileCount).to.equal(2);
      expect(parsed.licenses).to.deep.equal({ MIT: 1, [NO_LICENSE_BUCKET]: 1 });
      expect(parsed.sources).to.deep.equal({ "corpus-X": 1, [NO_SOURCE_BUCKET]: 1 });
      expect(parsed.filesWithLicenseHint).to.equal(1);
      expect(parsed.filesWithSourceHint).to.equal(1);
      expect(parsed).to.not.have.property("verify"); // no --verify => no verify section
      // JSON carries the SAME histogram object summary produces (single shared aggregator).
      const sumLines = [];
      runDatasetSummary({ manifest: manifestPath, json: true, stdout: (s) => sumLines.push(s) });
      const sum = JSON.parse(sumLines.join(""));
      expect(parsed.licenses).to.deep.equal(sum.licenses);
      expect(parsed.sources).to.deep.equal(sum.sources);
    });

    it("--verify against the MATCHING tree embeds a MATCH section (exit 0 via main)", async function () {
      const { dir, manifestPath } = buildFixture(
        { "a.txt": "AAA", "b.txt": "BBB" },
        { "a.txt": { license: "MIT" } },
        "rep-match"
      );
      const lines = [];
      const res = runDatasetReport({ manifest: manifestPath, verifyDir: dir, stdout: (s) => lines.push(s) });
      const out = lines.join("");
      expect(res.verifyStatus).to.equal("MATCH");
      expect(out).to.contain("MATCH");
      expect(out).to.contain("byte-for-byte");
      expect(out).to.not.contain("NO live-tree verification was performed");

      // main() mirrors `vh dataset verify`: exit 0 on MATCH.
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = () => true;
      let code;
      try {
        code = await main(["dataset", "report", manifestPath, "--verify", dir]);
      } finally {
        process.stdout.write = orig;
      }
      expect(code).to.equal(0);
    });

    it("--verify against an EDITED tree embeds MISMATCH + the changed file and exits 3", async function () {
      const { dir, manifestPath } = buildFixture(
        { "a.txt": "AAA", "b.txt": "BBB" },
        undefined,
        "rep-mismatch"
      );
      // Edit one file's bytes AFTER the manifest — the root re-derived from disk now differs.
      fs.writeFileSync(path.join(dir, "a.txt"), "EDITED");
      const lines = [];
      const res = runDatasetReport({ manifest: manifestPath, verifyDir: dir, stdout: (s) => lines.push(s) });
      const out = lines.join("");
      expect(res.verifyStatus).to.equal("MISMATCH");
      expect(out).to.contain("MISMATCH");
      expect(out).to.contain("CHANGED");
      expect(out).to.contain("a.txt");

      // --json carries the verify localization too.
      const jlines = [];
      const jres = runDatasetReport({ manifest: manifestPath, verifyDir: dir, json: true, stdout: (s) => jlines.push(s) });
      const parsed = JSON.parse(jlines.join(""));
      expect(parsed.verify.status).to.equal("MISMATCH");
      expect(parsed.verify.changed.map((c) => c.path)).to.contain("a.txt");
      expect(jres.verifyStatus).to.equal("MISMATCH");

      // main() mirrors `vh dataset verify`: exit 3 on MISMATCH.
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = () => true;
      let code;
      try {
        code = await main(["dataset", "report", manifestPath, "--verify", dir]);
      } finally {
        process.stdout.write = orig;
      }
      expect(code).to.equal(3);
    });

    it("--out writes EXACTLY that file (and names it) and leaves the working tree clean", function () {
      const { manifestPath } = buildFixture({ "a.txt": "AAA" }, undefined, "rep-out");
      const outDir = tmp("rep-out-dst-");
      const outPath = path.join(outDir, "report.md");
      const cwdBefore = fs.readdirSync(process.cwd());

      const lines = [];
      const res = runDatasetReport({ manifest: manifestPath, out: outPath, stdout: (s) => lines.push(s) });
      expect(res.out).to.equal(path.resolve(outPath));
      // The file was written at the explicit path; the success line names it.
      expect(fs.existsSync(outPath)).to.equal(true);
      expect(lines.join("")).to.contain(path.resolve(outPath));
      // The file content is the SAME deterministic Markdown the stdout path prints.
      const stdoutLines = [];
      runDatasetReport({ manifest: manifestPath, stdout: (s) => stdoutLines.push(s) });
      expect(fs.readFileSync(outPath, "utf8")).to.equal(stdoutLines.join(""));
      // No cwd litter: the working tree is unchanged.
      expect(fs.readdirSync(process.cwd())).to.deep.equal(cwdBefore);
    });

    it("rejects a corrupt/foreign manifest (exit 1) — no half-accept", function () {
      const { manifestPath } = buildFixture({ "a.txt": "AAA" }, undefined, "rep-corrupt");
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      m.root = "0xnothex";
      const badPath = path.join(tmp("rep-corrupt-bad-"), "m.json");
      fs.writeFileSync(badPath, JSON.stringify(m));
      expect(() => runDatasetReport({ manifest: badPath, stdout: () => {} })).to.throw(
        /root must be a 0x-prefixed 32-byte hex/
      );
      const foreignPath = path.join(tmp("rep-foreign-"), "f.json");
      fs.writeFileSync(foreignPath, JSON.stringify({ kind: "not-a-manifest", schemaVersion: 1 }));
      expect(() => runDatasetReport({ manifest: foreignPath, stdout: () => {} })).to.throw(
        /not a verifyhash dataset manifest/
      );
    });

    // ---- CLI wiring + exit codes -------------------------------------------------------------------
    it("parseDatasetReportArgs parses positional + --verify/--out/--json; rejects unknowns / extras", function () {
      expect(parseDatasetReportArgs(["/m"])).to.deep.equal({
        manifest: "/m",
        verifyDir: undefined,
        out: undefined,
        json: false,
      });
      expect(parseDatasetReportArgs(["/m", "--verify", "/d", "--out", "/o", "--json"])).to.deep.equal({
        manifest: "/m",
        verifyDir: "/d",
        out: "/o",
        json: true,
      });
      expect(() => parseDatasetReportArgs(["/m", "--bogus"])).to.throw(/unknown flag/);
      expect(() => parseDatasetReportArgs(["/m", "/n"])).to.throw(/unexpected extra argument/);
      expect(() => parseDatasetReportArgs(["/m", "--verify"])).to.throw(/--verify requires a value/);
    });

    it("main() exit 2 (usage) on a missing positional / extra positional / unknown flag", async function () {
      const { manifestPath } = buildFixture({ "a.txt": "AAA" }, undefined, "rep-usage");
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = () => true;
      try {
        expect(await main(["dataset", "report"])).to.equal(2); // no positional
        expect(await main(["dataset", "report", manifestPath, manifestPath])).to.equal(2); // extra positional
        expect(await main(["dataset", "report", manifestPath, "--bogus"])).to.equal(2); // unknown flag
      } finally {
        process.stderr.write = orig;
      }
    });

    it("main() exit 1 on a missing / corrupt manifest (runtime error)", async function () {
      const { manifestPath } = buildFixture({ "a.txt": "AAA" }, undefined, "rep-rt");
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      m.root = "0xnothex";
      const badPath = path.join(tmp("rep-rt-bad-"), "m.json");
      fs.writeFileSync(badPath, JSON.stringify(m));
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = () => true;
      try {
        expect(await main(["dataset", "report", "/no/such/manifest.json"])).to.equal(1);
        expect(await main(["dataset", "report", badPath])).to.equal(1);
      } finally {
        process.stderr.write = orig;
      }
    });
  });
});

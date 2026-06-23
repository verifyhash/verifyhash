"use strict";

// Tests for `vh parcel build` / `vh parcel verify` and cli/parcel.js (ProofParcel, T-18.2).
//
// What these prove (all OFFLINE — no provider, no signer, no network is ever constructed):
//   * A parcel manifest is the SAME Merkle root + per-file {relPath,contentHash,leaf} as a dataset
//     manifest built over the same tree (THIN adapter over the shared core; no new hashing convention).
//   * The OPTIONAL `parcel` block {parcelId,sender,recipient} is recorded as clearly-UNTRUSTED metadata,
//     preserved through build/verify, and is NOT bound into the root (editing it leaves the root fixed).
//   * `vh parcel verify` re-derives the root from a FRESH copy on disk and prints MATCH (exit 0) for a
//     clean copy, MISMATCH (exit 3) with a PRECISE per-file ADDED/REMOVED/CHANGED diff after a tamper.
//   * A manifest from a DIFFERENT tree reports full divergence (not a silent mislabel).
//   * `--json` round-trips for both commands.
//   * Every human-output run LEADS with the shared TRUST_NOTE (verbatim) + the parcel-specific caveat.
//   * The two product `kind`s NEVER cross-validate: a parcel manifest is REJECTED by the dataset
//     validator and a dataset manifest is REJECTED by the parcel validator.
//   * Unknown/incomplete flags hard-error with usage (parser parity).
//   * Side effects land ONLY at the caller's --out path (no cwd litter); every test isolates to a
//     throwaway temp dir and self-cleans, pass or fail.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { hashDir } = require("../cli/hash");
const {
  PARCEL_MANIFEST_KIND,
  PARCEL_TRUST_NOTE,
  TRUST_NOTE,
  buildParcelManifest,
  validateParcelManifest,
  readParcelManifest,
  writeParcelManifest,
  normalizeParcelBlock,
  runParcelBuild,
  runParcelVerify,
} = require("../cli/parcel");
const { validateManifest, readManifest, runDatasetVerify } = require("../cli/dataset");
const { main, parseParcelBuildArgs, parseParcelVerifyArgs } = require("../cli/vh");

// --- temp-dir isolation: every test gets throwaway dirs, removed in afterEach (pass OR fail) ----------
let tmpDirs = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}
// Capture everything main() (or a run*()) writes to stdout, restoring the real write afterwards.
async function capture(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  process.stdout.write = (s) => {
    buf += s;
    return true;
  };
  try {
    const ret = await fn();
    return { ret, out: buf };
  } finally {
    process.stdout.write = orig;
  }
}

afterEach(function () {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

// Three-file parcel with parcel metadata, used across the suite.
const THREE = Object.freeze({ "a.txt": "alpha", "src/b.txt": "beta", "c.txt": "gamma" });
const META = Object.freeze({ parcelId: "PX-42", sender: "Acme Data", recipient: "Beta Corp" });

describe("cli/parcel.js — ProofParcel delivery receipt (T-18.2)", function () {
  // ---------------------------------------------------------------------------------------------------
  // build
  // ---------------------------------------------------------------------------------------------------
  describe("vh parcel build", function () {
    it("builds a 3-file parcel with metadata; same root as a dataset manifest; meta NOT in the root", function () {
      const dir = writeFiles(tmp("pb-"), THREE);
      const out = path.join(tmp("pb-out-"), "p.json");
      const r = runParcelBuild({ dir, out, parcel: META, stdout: () => {} });

      expect(r.fileCount).to.equal(3);
      expect(r.root).to.equal(hashDir(dir).root); // SAME shared Merkle convention as a dataset manifest
      expect(r.parcel).to.deep.equal(META);

      const m = readParcelManifest(out);
      expect(m.kind).to.equal(PARCEL_MANIFEST_KIND);
      expect(m.parcel).to.deep.equal(META);
      expect(m.files).to.have.length(3);

      // The parcel block is NOT bound into the root: a manifest with NO parcel block over the same tree
      // has the IDENTICAL root.
      const out2 = path.join(tmp("pb-out2-"), "p.json");
      const r2 = runParcelBuild({ dir, out: out2, stdout: () => {} });
      expect(r2.root).to.equal(r.root);
      expect(r2.parcel).to.equal(undefined);
    });

    it("writes ONLY to the caller's --out path (no cwd litter)", async function () {
      const dir = writeFiles(tmp("pb-cwd-"), THREE);
      const outDir = tmp("pb-cwd-out-");
      const out = path.join(outDir, "p.json");
      const before = fs.readdirSync(process.cwd());
      const code = await capture(() =>
        main(["parcel", "build", dir, "--out", out, "--parcel-id", "X"])
      ).then((c) => c.ret);
      expect(code).to.equal(0);
      expect(fs.existsSync(out)).to.equal(true);
      // The ONLY new file is at --out; the working tree gained nothing.
      expect(fs.readdirSync(outDir)).to.deep.equal(["p.json"]);
      expect(fs.readdirSync(process.cwd())).to.deep.equal(before);
    });

    it("human output LEADS with the shared TRUST_NOTE (verbatim) + the parcel-specific caveat", async function () {
      const dir = writeFiles(tmp("pb-trust-"), THREE);
      const out = path.join(tmp("pb-trust-out-"), "p.json");
      const { out: text } = await capture(() =>
        main(["parcel", "build", dir, "--out", out, "--sender", "Acme"])
      );
      const noteIdx = text.indexOf(TRUST_NOTE);
      const caveatIdx = text.indexOf(PARCEL_TRUST_NOTE);
      expect(noteIdx, "shared TRUST_NOTE present verbatim").to.be.greaterThan(-1);
      expect(caveatIdx, "parcel caveat present verbatim").to.be.greaterThan(-1);
      // Both lead: they appear BEFORE the written-path / root lines.
      expect(noteIdx).to.be.lessThan(text.indexOf("parcel manifest written"));
      expect(caveatIdx).to.be.lessThan(text.indexOf("parcel manifest written"));
      // The metadata is flagged UNTRUSTED in human output.
      expect(text).to.match(/UNTRUSTED/);
    });

    it("--json round-trips { root, fileCount, out, parcel }", async function () {
      const dir = writeFiles(tmp("pb-json-"), THREE);
      const out = path.join(tmp("pb-json-out-"), "p.json");
      const { ret: code, out: text } = await capture(() =>
        main([
          "parcel",
          "build",
          dir,
          "--out",
          out,
          "--parcel-id",
          META.parcelId,
          "--sender",
          META.sender,
          "--recipient",
          META.recipient,
          "--json",
        ])
      );
      expect(code).to.equal(0);
      const obj = JSON.parse(text);
      expect(obj.root).to.equal(hashDir(dir).root);
      expect(obj.fileCount).to.equal(3);
      expect(obj.parcel).to.deep.equal(META);
      expect(path.resolve(obj.out)).to.equal(path.resolve(out));
    });

    it("exit 2 (usage) when --out is missing, and 2 on an unknown subcommand", async function () {
      const dir = writeFiles(tmp("pb-noout-"), THREE);
      expect(await capture(() => main(["parcel", "build", dir])).then((c) => c.ret)).to.equal(2);
      expect(await capture(() => main(["parcel", "frobnicate"])).then((c) => c.ret)).to.equal(2);
      expect(await capture(() => main(["parcel"])).then((c) => c.ret)).to.equal(2);
    });

    it("exit 1 when the target dir does not exist (writes nothing)", async function () {
      const out = path.join(tmp("pb-missing-out-"), "p.json");
      const code = await capture(() =>
        main(["parcel", "build", "/no/such/parcel/dir", "--out", out])
      ).then((c) => c.ret);
      expect(code).to.equal(1);
      expect(fs.existsSync(out)).to.equal(false);
    });

    it("parser rejects unknown/incomplete flags and a duplicate positional (parity)", function () {
      expect(() => parseParcelBuildArgs(["/d", "--out", "/o", "--bogus"])).to.throw(/unknown flag/);
      expect(() => parseParcelBuildArgs(["/d", "/e"])).to.throw(/unexpected extra argument/);
      expect(() => parseParcelBuildArgs(["/d", "--out"])).to.throw(/--out requires a value/);
      expect(() => parseParcelBuildArgs(["/d", "--sender"])).to.throw(/--sender requires a value/);
      expect(() => parseParcelBuildArgs(["/d", "--parcel-id"])).to.throw(/--parcel-id requires a value/);
      expect(() => parseParcelBuildArgs(["/d", "--recipient"])).to.throw(/--recipient requires a value/);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // verify — clean MATCH, and a tamper localized to the exact file (exit 0/3 mirroring dataset verify)
  // ---------------------------------------------------------------------------------------------------
  describe("vh parcel verify (OFFLINE re-derive + precise per-file diff)", function () {
    // Build a manifest for THREE in `dir`, returning dir + manifest path.
    function built(prefix, files = THREE, parcel = META) {
      const dir = writeFiles(tmp(prefix), files);
      const out = path.join(tmp(prefix + "out-"), "p.json");
      runParcelBuild({ dir, out, parcel, stdout: () => {} });
      return { dir, manifest: out };
    }

    it("a clean copy MATCHes (exit 0) and preserves the untrusted parcel block in the result", async function () {
      const { dir, manifest } = built("pv-clean-");
      const r = runParcelVerify({ dir, manifest, stdout: () => {} });
      expect(r.status).to.equal("MATCH");
      expect(r.diff.identical).to.equal(true);
      expect(r.parcel).to.deep.equal(META);

      const code = await capture(() =>
        main(["parcel", "verify", dir, "--manifest", manifest])
      ).then((c) => c.ret);
      expect(code).to.equal(0);
    });

    it("verify human output LEADS with TRUST_NOTE + caveat and flags the parcel block untrusted", async function () {
      const { dir, manifest } = built("pv-trust-");
      const { out: text } = await capture(() => main(["parcel", "verify", dir, "--manifest", manifest]));
      const noteIdx = text.indexOf(TRUST_NOTE);
      const caveatIdx = text.indexOf(PARCEL_TRUST_NOTE);
      expect(noteIdx).to.be.greaterThan(-1);
      expect(caveatIdx).to.be.greaterThan(-1);
      expect(noteIdx).to.be.lessThan(text.indexOf("parcel verify:"));
      expect(caveatIdx).to.be.lessThan(text.indexOf("parcel verify:"));
      // The parcel block is shown but explicitly NOT part of the verdict.
      expect(text).to.match(/plays NO part in the verdict/);
    });

    it("a CHANGED file → exit 3, exactly that file CHANGED, nothing ADDED/REMOVED", async function () {
      const { dir, manifest } = built("pv-changed-");
      fs.writeFileSync(path.join(dir, "a.txt"), "ALPHA-EDITED");
      const r = runParcelVerify({ dir, manifest, stdout: () => {} });
      expect(r.status).to.equal("MISMATCH");
      expect(r.diff.changed.map((c) => c.path)).to.deep.equal(["a.txt"]);
      expect(r.diff.added).to.have.length(0);
      expect(r.diff.removed).to.have.length(0);
      expect(r.diff.changed[0].oldContentHash).to.not.equal(r.diff.changed[0].newContentHash);

      const code = await capture(() =>
        main(["parcel", "verify", dir, "--manifest", manifest])
      ).then((c) => c.ret);
      expect(code).to.equal(3);
    });

    it("an ADDED file → exit 3, exactly that file ADDED", async function () {
      const { dir, manifest } = built("pv-added-");
      fs.writeFileSync(path.join(dir, "extra.txt"), "surprise");
      const r = runParcelVerify({ dir, manifest, stdout: () => {} });
      expect(r.status).to.equal("MISMATCH");
      expect(r.diff.added.map((a) => a.path)).to.deep.equal(["extra.txt"]);
      expect(r.diff.changed).to.have.length(0);
      expect(r.diff.removed).to.have.length(0);
    });

    it("a REMOVED file → exit 3, exactly that file REMOVED", async function () {
      const { dir, manifest } = built("pv-removed-");
      fs.rmSync(path.join(dir, "c.txt"));
      const r = runParcelVerify({ dir, manifest, stdout: () => {} });
      expect(r.status).to.equal("MISMATCH");
      expect(r.diff.removed.map((rm) => rm.path)).to.deep.equal(["c.txt"]);
      expect(r.diff.changed).to.have.length(0);
      expect(r.diff.added).to.have.length(0);
    });

    it("editing the UNTRUSTED parcel block does NOT change the verdict (still MATCH)", function () {
      const { dir, manifest } = built("pv-meta-");
      // Hand-edit the parcel block (self-asserted metadata); leave files untouched.
      const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
      m.parcel.sender = "Someone Else Entirely";
      fs.writeFileSync(manifest, JSON.stringify(m, null, 2) + "\n");
      const r = runParcelVerify({ dir, manifest, stdout: () => {} });
      expect(r.status).to.equal("MATCH"); // root unaffected — meta is not bound into it
      expect(r.parcel.sender).to.equal("Someone Else Entirely"); // echoed back, untrusted
    });

    it("a manifest from a DIFFERENT tree reports FULL divergence, not a silent mislabel", function () {
      // Manifest is over THREE; verify a completely different tree on disk.
      const { manifest } = built("pv-divA-");
      const otherDir = writeFiles(tmp("pv-divB-"), {
        "x.txt": "ex",
        "y/z.txt": "zee",
      });
      const r = runParcelVerify({ dir: otherDir, manifest, stdout: () => {} });
      expect(r.status).to.equal("MISMATCH");
      // Every original file is REMOVED, every new file is ADDED, nothing CHANGED (disjoint paths).
      expect(r.diff.removed.map((x) => x.path).sort()).to.deep.equal(["a.txt", "c.txt", "src/b.txt"]);
      expect(r.diff.added.map((x) => x.path).sort()).to.deep.equal(["x.txt", "y/z.txt"]);
      expect(r.diff.changed).to.have.length(0);
    });

    it("--json round-trips the verify result (status, roots, parcel, diff)", async function () {
      const { dir, manifest } = built("pv-json-");
      fs.writeFileSync(path.join(dir, "a.txt"), "EDITED");
      const { ret: code, out: text } = await capture(() =>
        main(["parcel", "verify", dir, "--manifest", manifest, "--json"])
      );
      expect(code).to.equal(3);
      const obj = JSON.parse(text);
      expect(obj.status).to.equal("MISMATCH");
      expect(obj.recomputedRoot).to.equal(hashDir(dir).root);
      expect(obj.parcel).to.deep.equal(META);
      expect(obj.diff.changed.map((c) => c.path)).to.deep.equal(["a.txt"]);
    });

    it("a hand-edited manifest `root` cannot fake a MATCH (root is recomputed, not read)", function () {
      const { dir, manifest } = built("pv-fakeroot-");
      // Tamper a file AND rewrite the manifest root to the new (tampered) root — verify must still
      // recompute from disk and... actually MATCH, because we set root to the live tree. So instead set
      // root to a BOGUS value while leaving files clean: a clean tree must NOT MATCH a lying root.
      fs.writeFileSync(path.join(dir, "a.txt"), "alpha"); // ensure clean
      const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
      // Re-point root at a different but well-formed 32-byte hex (a different file's contentHash).
      m.root = "0x" + "ab".repeat(32);
      fs.writeFileSync(manifest, JSON.stringify(m, null, 2) + "\n");
      const r = runParcelVerify({ dir, manifest, stdout: () => {} });
      expect(r.status).to.equal("MISMATCH"); // recomputed root != lying manifest root
      expect(r.diff.identical).to.equal(true); // yet every FILE matches — the diff localizes nothing
    });

    it("parser parity: unknown/incomplete flags hard-error; missing --manifest is exit 2", async function () {
      expect(() => parseParcelVerifyArgs(["/d", "--bogus"])).to.throw(/unknown flag/);
      expect(() => parseParcelVerifyArgs(["/d", "/e"])).to.throw(/unexpected extra argument/);
      expect(() => parseParcelVerifyArgs(["/d", "--manifest"])).to.throw(/--manifest requires a value/);
      const dir = writeFiles(tmp("pv-nom-"), THREE);
      const code = await capture(() => main(["parcel", "verify", dir])).then((c) => c.ret);
      expect(code).to.equal(2);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // The two product `kind`s NEVER cross-validate (the load-bearing isolation guarantee).
  // ---------------------------------------------------------------------------------------------------
  describe("kind isolation: parcel and dataset manifests never cross-validate", function () {
    it("the DATASET validator REJECTS a parcel manifest", function () {
      const dir = writeFiles(tmp("xv-p-"), THREE);
      const out = path.join(tmp("xv-p-out-"), "p.json");
      runParcelBuild({ dir, out, parcel: META, stdout: () => {} });
      const obj = JSON.parse(fs.readFileSync(out, "utf8"));
      expect(() => validateManifest(obj)).to.throw(/not a verifyhash dataset manifest/);
      expect(() => readManifest(out)).to.throw(/not a verifyhash dataset manifest/);
    });

    it("the PARCEL validator REJECTS a dataset manifest", async function () {
      const dir = writeFiles(tmp("xv-d-"), THREE);
      const out = path.join(tmp("xv-d-out-"), "d.json");
      const code = await capture(() => main(["dataset", "build", dir, "--out", out])).then(
        (c) => c.ret
      );
      expect(code).to.equal(0);
      const obj = JSON.parse(fs.readFileSync(out, "utf8"));
      expect(() => validateParcelManifest(obj)).to.throw(/not a verifyhash parcel manifest/);
      expect(() => readParcelManifest(out)).to.throw(/not a verifyhash parcel manifest/);
    });

    it("`vh parcel verify` against a dataset manifest is a runtime error (exit 1), not a MATCH", async function () {
      const dir = writeFiles(tmp("xv-pv-"), THREE);
      const out = path.join(tmp("xv-pv-out-"), "d.json");
      await capture(() => main(["dataset", "build", dir, "--out", out]));
      const code = await capture(() =>
        main(["parcel", "verify", dir, "--manifest", out])
      ).then((c) => c.ret);
      expect(code).to.equal(1);
    });

    it("`vh dataset verify` against a parcel manifest is a runtime error (exit 1), not a MATCH", async function () {
      const dir = writeFiles(tmp("xv-dv-"), THREE);
      const out = path.join(tmp("xv-dv-out-"), "p.json");
      runParcelBuild({ dir, out, parcel: META, stdout: () => {} });
      // runDatasetVerify reads strictly via the dataset validator → throws → cmd maps to exit 1.
      expect(() => runDatasetVerify({ dir, manifest: out, stdout: () => {} })).to.throw(
        /not a verifyhash dataset manifest/
      );
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // strictness + parcel-block normalization
  // ---------------------------------------------------------------------------------------------------
  describe("strict validation + parcel-block normalization", function () {
    it("normalizeParcelBlock keeps only string parcelId/sender/recipient and drops empties", function () {
      expect(normalizeParcelBlock(undefined)).to.equal(undefined);
      expect(normalizeParcelBlock({})).to.equal(undefined);
      expect(normalizeParcelBlock({ parcelId: "P", sender: "S" })).to.deep.equal({
        parcelId: "P",
        sender: "S",
      });
      expect(() => normalizeParcelBlock({ bogus: "x" })).to.throw(/unknown parcel metadata field/);
      expect(() => normalizeParcelBlock({ sender: 7 })).to.throw(/sender must be a string/);
      expect(() => normalizeParcelBlock("nope")).to.throw(/parcel metadata must be an object/);
    });

    it("readParcelManifest rejects a tampered leaf, a bad schemaVersion, and a bad parcel block", function () {
      const dir = writeFiles(tmp("sv-"), THREE);
      const out = path.join(tmp("sv-out-"), "p.json");
      runParcelBuild({ dir, out, parcel: META, stdout: () => {} });

      const good = JSON.parse(fs.readFileSync(out, "utf8"));

      const badLeaf = JSON.parse(JSON.stringify(good));
      badLeaf.files[0].leaf = "0x" + "00".repeat(32);
      expect(() => validateParcelManifest(badLeaf)).to.throw(/inconsistent with its relPath/);

      const badVer = JSON.parse(JSON.stringify(good));
      badVer.schemaVersion = 999;
      expect(() => validateParcelManifest(badVer)).to.throw(/unsupported parcel manifest schemaVersion/);

      const badBlock = JSON.parse(JSON.stringify(good));
      badBlock.parcel = { sender: 123 };
      expect(() => validateParcelManifest(badBlock)).to.throw(/parcel`.sender must be a string|sender/);

      const badField = JSON.parse(JSON.stringify(good));
      badField.parcel = { evil: "x" };
      expect(() => validateParcelManifest(badField)).to.throw(/unknown field/);
    });

    it("writeParcelManifest validates before writing — a corrupt manifest never lands on disk", function () {
      const out = path.join(tmp("wv-out-"), "p.json");
      expect(() => writeParcelManifest({ kind: "nope" }, out)).to.throw();
      expect(fs.existsSync(out)).to.equal(false);
    });

    it("buildParcelManifest round-trips through validate (build→validate is byte-stable)", function () {
      const dir = writeFiles(tmp("rt-"), THREE);
      const m = buildParcelManifest(hashDir(dir), { parcel: META });
      expect(() => validateParcelManifest(m)).to.not.throw();
      expect(m.parcel).to.deep.equal(META);
    });
  });
});

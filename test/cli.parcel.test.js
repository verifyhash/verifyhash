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

// =====================================================================================================
// T-18.3: `vh parcel attest` (canonical UNSIGNED payload) + `vh parcel verify-attest` (OFFLINE verifier),
// over the SAME signed-attestation core as `vh dataset`. Proves the full attest -> sign (EPHEMERAL
// throwaway key) -> wrap -> verify-attest loop end-to-end and the wrap-don't-edit invariant.
//
// CRITICAL: every key here is an EPHEMERAL, in-process `Wallet.createRandom()` — a TEST-ONLY key that is
// NEVER persisted and NEVER a real-funds key. NO network, NO provider anywhere (the verifier is offline).
// =====================================================================================================
const { Wallet, getAddress } = require("ethers");
const {
  PARCEL_ATTESTATION_KIND,
  PARCEL_ATTESTATION_TRUST_NOTE,
  SIGNED_PARCEL_ATTESTATION_KIND,
  SIGNED_PARCEL_ATTESTATION_SCHEMES,
  PARCEL_VERIFY_ATTEST_TRUST_NOTE,
  buildParcelAttestation,
  serializeParcelAttestation,
  validateParcelAttestation,
  readParcelAttestation,
  buildSignedParcelAttestation,
  serializeSignedParcelAttestation,
  readSignedParcelAttestation,
  validateSignedParcelAttestation,
  runParcelAttest,
  runParcelVerifyAttest,
} = require("../cli/parcel");
const {
  validateAttestation: validateDatasetAttestation,
  validateSignedAttestation: validateDatasetSignedAttestation,
  buildAttestation: buildDatasetAttestation,
  serializeAttestation: serializeDatasetAttestation,
  buildSignedAttestation: buildDatasetSignedAttestation,
  serializeSignedAttestation: serializeDatasetSignedAttestation,
  runDatasetBuild,
  readManifest: readDatasetManifest,
} = require("../cli/dataset");
const {
  parseParcelAttestArgs,
  parseParcelVerifyAttestArgs,
} = require("../cli/vh");

describe("cli/parcel.js — ProofParcel attest + verify-attest (T-18.3)", function () {
  let tmpDirs2 = [];
  function tmp2(prefix) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs2.push(d);
    return d;
  }
  afterEach(function () {
    for (const d of tmpDirs2) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs2 = [];
  });

  // Build a parcel manifest from a fresh tree -> { manifestPath, manifest, unsigned, canonical }.
  function buildFixture(files = THREE, prefix = "pa", parcel = META) {
    const dir = writeFiles(tmp2(prefix + "-tree-"), files);
    const manifestPath = path.join(tmp2(prefix + "-man-"), "p.json");
    runParcelBuild({ dir, out: manifestPath, parcel, stdout: () => {} });
    const manifest = readParcelManifest(manifestPath);
    const unsigned = buildParcelAttestation(manifest);
    const canonical = serializeParcelAttestation(unsigned);
    return { dir, manifestPath, manifest, unsigned, canonical };
  }

  // attest -> sign EXACT canonical bytes (EPHEMERAL throwaway key) -> wrap -> write the signed container.
  async function signFixture(files, prefix, wallet, parcel = META) {
    const fx = buildFixture(files, prefix, parcel);
    const w = wallet || Wallet.createRandom(); // TEST-ONLY key — never persisted, never funded
    expect(w.privateKey).to.match(/^0x[0-9a-fA-F]{64}$/);
    const signature = (await w.signMessage(fx.canonical)).toLowerCase();
    const container = buildSignedParcelAttestation({
      attestation: fx.unsigned,
      scheme: "eip191-personal-sign",
      signer: w.address.toLowerCase(),
      signature,
    });
    const signedPath = path.join(tmp2(prefix + "-signed-"), "signed.json");
    fs.writeFileSync(signedPath, serializeSignedParcelAttestation(container));
    return { ...fx, wallet: w, container, signedPath };
  }

  // -----------------------------------------------------------------------------------------------
  // attest — the canonical UNSIGNED payload
  // -----------------------------------------------------------------------------------------------
  describe("vh parcel attest (canonical UNSIGNED payload)", function () {
    it("emits a deterministic UNSIGNED envelope (root + fileCount + manifestDigest), signed:false", function () {
      const fx = buildFixture();
      expect(fx.unsigned.kind).to.equal(PARCEL_ATTESTATION_KIND);
      expect(fx.unsigned.root).to.equal(fx.manifest.root);
      expect(fx.unsigned.fileCount).to.equal(3);
      expect(fx.unsigned.manifestDigest).to.match(/^0x[0-9a-f]{64}$/);
      expect(fx.unsigned.signed).to.equal(false);
      expect(fx.unsigned.signature).to.equal(null);
      // The in-band note points at the human signing trust-root P-3, never claims a timestamp.
      expect(fx.unsigned.note).to.equal(PARCEL_ATTESTATION_TRUST_NOTE);
      expect(fx.unsigned.note).to.include("P-3");
      expect(fx.unsigned.note).to.match(/not.*timestamp/i);
      // Byte-deterministic: a second attest over the same manifest yields identical bytes.
      const again = serializeParcelAttestation(buildParcelAttestation(fx.manifest));
      expect(again).to.equal(fx.canonical);
    });

    it("the UNTRUSTED parcel block is EXCLUDED from the signed identity (digest ignores it)", function () {
      // Two parcels over the SAME files but DIFFERENT parcel metadata yield the SAME manifestDigest+root.
      const a = buildFixture(THREE, "pa-excl-a", { parcelId: "PX-1", sender: "Acme" });
      const b = buildFixture(THREE, "pa-excl-b", { parcelId: "PX-999", sender: "Other" });
      expect(b.unsigned.root).to.equal(a.unsigned.root);
      expect(b.unsigned.manifestDigest).to.equal(a.unsigned.manifestDigest);
      expect(a.canonical).to.equal(b.canonical); // metadata is NOT in the signable bytes
    });

    it("--out writes the canonical bytes to the caller's explicit path (no cwd litter); --json IS those bytes", async function () {
      const fx = buildFixture();
      const outDir = tmp2("pa-out-");
      const out = path.join(outDir, "att.json");
      const before = fs.readdirSync(process.cwd());
      const { ret: code } = await capture(() =>
        main(["parcel", "attest", fx.manifestPath, "--out", out])
      );
      expect(code).to.equal(0);
      expect(fs.readFileSync(out, "utf8")).to.equal(fx.canonical); // exact canonical bytes on disk
      expect(fs.readdirSync(outDir)).to.deep.equal(["att.json"]);
      expect(fs.readdirSync(process.cwd())).to.deep.equal(before); // nothing leaked into cwd

      const { ret: code2, out: text } = await capture(() =>
        main(["parcel", "attest", fx.manifestPath, "--json"])
      );
      expect(code2).to.equal(0);
      expect(text).to.equal(fx.canonical); // --json stdout IS the signable bytes
    });

    it("a DATASET manifest is rejected by `vh parcel attest` (exit 1)", async function () {
      const dir = writeFiles(tmp2("pa-xkind-"), THREE);
      const dman = path.join(tmp2("pa-xkind-out-"), "d.json");
      await capture(() => main(["dataset", "build", dir, "--out", dman]));
      const code = await capture(() => main(["parcel", "attest", dman])).then((c) => c.ret);
      expect(code).to.equal(1);
    });

    it("readParcelAttestation rejects a DATASET attestation (kinds never cross-validate)", function () {
      const dir = writeFiles(tmp2("pa-roundtrip-"), THREE);
      const dman = path.join(tmp2("pa-roundtrip-out-"), "d.json");
      runDatasetBuild({ dir, out: dman, stdout: () => {} });
      const dAtt = buildDatasetAttestation(readDatasetManifest(dman));
      // A dataset attestation envelope must NOT validate as a parcel attestation (distinct kind).
      expect(() => validateParcelAttestation(dAtt)).to.throw(/not a verifyhash parcel attestation/);
    });

    it("parser parity: unknown/incomplete flag, duplicate positional; missing <manifest> is exit 2", async function () {
      expect(() => parseParcelAttestArgs(["/m", "--bogus"])).to.throw(/unknown flag/);
      expect(() => parseParcelAttestArgs(["/m", "/n"])).to.throw(/unexpected extra argument/);
      expect(() => parseParcelAttestArgs(["/m", "--out"])).to.throw(/--out requires a value/);
      const code = await capture(() => main(["parcel", "attest"])).then((c) => c.ret);
      expect(code).to.equal(2);
    });
  });

  // -----------------------------------------------------------------------------------------------
  // verify-attest — the OFFLINE verifier, full attest->sign->wrap->verify loop
  // -----------------------------------------------------------------------------------------------
  describe("vh parcel verify-attest (OFFLINE; full attest->sign->wrap->verify loop)", function () {
    it("ACCEPTS a genuine signature over a parcel (recovers to the claimed signer)", async function () {
      const fx = await signFixture(THREE, "pva-accept");
      let out = "";
      const r = runParcelVerifyAttest({ signed: fx.signedPath, stdout: (s) => (out += s) });
      expect(r.verdict).to.equal("ACCEPTED");
      expect(r.recoveredSigner).to.equal(fx.wallet.address.toLowerCase());
      expect(r.claimedSigner).to.equal(fx.wallet.address.toLowerCase());
      expect(r.checks.signatureMatchesSigner).to.equal(true);
      expect(r.checks.signerMatchesExpected).to.equal(null);
      expect(r.checks.manifestBindsAttestation).to.equal(null);
      expect(out).to.contain("ACCEPTED");
      // Exit 0 through the CLI.
      const code = await capture(() => main(["parcel", "verify-attest", fx.signedPath])).then(
        (c) => c.ret
      );
      expect(code).to.equal(0);
    });

    it("the signed container uses ProofParcel's OWN kind", async function () {
      const fx = await signFixture(THREE, "pva-kind");
      const onDisk = JSON.parse(fs.readFileSync(fx.signedPath, "utf8"));
      expect(onDisk.kind).to.equal(SIGNED_PARCEL_ATTESTATION_KIND);
      expect(onDisk.kind).to.equal("verifyhash.parcel-attestation-signed");
      expect(SIGNED_PARCEL_ATTESTATION_SCHEMES).to.include("eip191-personal-sign");
    });

    it("a DATASET signed-container does NOT cross-verify as a parcel one (and vice-versa)", async function () {
      // Build + sign a DATASET attestation over the same files with a throwaway key.
      const dir = writeFiles(tmp2("pva-cross-tree-"), THREE);
      const dman = path.join(tmp2("pva-cross-man-"), "d.json");
      runDatasetBuild({ dir, out: dman, stdout: () => {} });
      const dUnsigned = buildDatasetAttestation(readDatasetManifest(dman));
      const dCanon = serializeDatasetAttestation(dUnsigned);
      const w = Wallet.createRandom(); // TEST-ONLY key
      const dSig = (await w.signMessage(dCanon)).toLowerCase();
      const dContainer = buildDatasetSignedAttestation({
        attestation: dUnsigned,
        scheme: "eip191-personal-sign",
        signer: w.address.toLowerCase(),
        signature: dSig,
      });
      const dSignedPath = path.join(tmp2("pva-cross-signed-"), "d-signed.json");
      fs.writeFileSync(dSignedPath, serializeDatasetSignedAttestation(dContainer));

      // The PARCEL verifier must REJECT the dataset signed-container (wrong kind) -> runtime error (exit 1).
      expect(() => readSignedParcelAttestation(dSignedPath)).to.throw(
        /not a verifyhash signed parcel attestation/
      );
      const code = await capture(() => main(["parcel", "verify-attest", dSignedPath])).then(
        (c) => c.ret
      );
      expect(code).to.equal(1);

      // And the converse: a PARCEL signed-container must NOT validate as a dataset signed-container.
      const pfx = await signFixture(THREE, "pva-cross2");
      const pOnDisk = JSON.parse(fs.readFileSync(pfx.signedPath, "utf8"));
      expect(() => validateDatasetSignedAttestation(pOnDisk)).to.throw(
        /not a verifyhash signed dataset attestation/
      );
    });

    it("a WRONG --signer REJECTS (signature genuine; only the expected-sender pin fails)", async function () {
      const fx = await signFixture(THREE, "pva-pin");
      // Right sender (checksummed form accepted) -> ACCEPTED + pin PASS.
      const ok = runParcelVerifyAttest({
        signed: fx.signedPath,
        signer: getAddress(fx.wallet.address),
        stdout: () => {},
      });
      expect(ok.verdict).to.equal("ACCEPTED");
      expect(ok.checks.signerMatchesExpected).to.equal(true);

      // A DIFFERENT expected sender -> REJECTED, naming the failed pin; signature itself still genuine.
      const other = Wallet.createRandom(); // TEST-ONLY key
      let out = "";
      const bad = runParcelVerifyAttest({
        signed: fx.signedPath,
        signer: other.address,
        stdout: (s) => (out += s),
      });
      expect(bad.verdict).to.equal("REJECTED");
      expect(bad.checks.signerMatchesExpected).to.equal(false);
      expect(bad.checks.signatureMatchesSigner).to.equal(true);
      expect(bad.failedChecks).to.deep.equal(["signerMatchesExpected"]);
      expect(out).to.contain("signerMatchesExpected");

      const code = await capture(() =>
        main(["parcel", "verify-attest", fx.signedPath, "--signer", other.address])
      ).then((c) => c.ret);
      expect(code).to.equal(3);
    });

    it("binding to a DIFFERENT --manifest REJECTS with a clear binding-mismatch", async function () {
      // Sign over parcel A...
      const fx = await signFixture(THREE, "pva-bind");
      // ...but the recipient holds a DIFFERENT parcel B (different content -> different canonical bytes).
      const otherDir = writeFiles(tmp2("pva-bind-other-tree-"), { "a.txt": "DIFFERENT", "src/b.txt": "beta", "c.txt": "gamma" });
      const otherMan = path.join(tmp2("pva-bind-other-man-"), "p.json");
      runParcelBuild({ dir: otherDir, out: otherMan, parcel: META, stdout: () => {} });

      // The matching manifest BINDS (ACCEPTED).
      const okR = runParcelVerifyAttest({ signed: fx.signedPath, manifest: fx.manifestPath, stdout: () => {} });
      expect(okR.verdict).to.equal("ACCEPTED");
      expect(okR.checks.manifestBindsAttestation).to.equal(true);

      // The different manifest does NOT bind (REJECTED).
      let out = "";
      const r = runParcelVerifyAttest({
        signed: fx.signedPath,
        manifest: otherMan,
        stdout: (s) => (out += s),
      });
      expect(r.verdict).to.equal("REJECTED");
      expect(r.checks.manifestBindsAttestation).to.equal(false);
      expect(r.checks.signatureMatchesSigner).to.equal(true); // signature genuine; only binding failed
      expect(r.failedChecks).to.deep.equal(["manifestBindsAttestation"]);
      expect(out).to.contain("binding-mismatch");
    });

    it("a TAMPERED container REJECTS (flipped signature recovers to a different address)", async function () {
      const fx = await signFixture(THREE, "pva-tamper");
      const onDisk = JSON.parse(serializeSignedParcelAttestation(fx.container));
      const sig = onDisk.signature.signature;
      const idx = 50;
      const ch = sig[idx] === "a" ? "b" : "a";
      onDisk.signature.signature = sig.slice(0, idx) + ch + sig.slice(idx + 1);
      const p = path.join(tmp2("pva-tamper-w-"), "signed.json");
      fs.writeFileSync(p, JSON.stringify(onDisk));
      const r = runParcelVerifyAttest({ signed: p, stdout: () => {} });
      expect(r.verdict).to.equal("REJECTED");
      expect(r.checks.signatureMatchesSigner).to.equal(false);
      expect(r.recoveredSigner).to.not.equal(r.claimedSigner);
    });

    it("the wrap-don't-edit invariant holds: the embedded payload stays signed:false", async function () {
      const fx = await signFixture(THREE, "pva-wrap");
      const onDisk = JSON.parse(fs.readFileSync(fx.signedPath, "utf8"));
      // The embedded `attestation` is the EXACT canonical UNSIGNED bytes (a string), still signed:false.
      expect(onDisk.attestation).to.equal(fx.canonical);
      const embedded = JSON.parse(onDisk.attestation);
      expect(embedded.signed).to.equal(false);
      expect(embedded.signature).to.equal(null);
      // The container re-validates (the core re-checks the embedded payload IS a sound UNSIGNED one).
      expect(() => validateSignedParcelAttestation(onDisk)).to.not.throw();
      // A container smuggling an already-"signed" embedded payload is rejected by the core invariant.
      const cheat = JSON.parse(JSON.stringify(onDisk));
      const ed = JSON.parse(cheat.attestation);
      ed.signed = true;
      cheat.attestation = JSON.stringify(ed) + "\n";
      expect(() => validateSignedParcelAttestation(cheat)).to.throw();
    });

    it("--json round-trips the verify-attest verdict (recovered signer + per-check booleans)", async function () {
      const fx = await signFixture(THREE, "pva-json");
      const { ret: code, out: text } = await capture(() =>
        main([
          "parcel",
          "verify-attest",
          fx.signedPath,
          "--manifest",
          fx.manifestPath,
          "--signer",
          fx.wallet.address,
          "--json",
        ])
      );
      expect(code).to.equal(0);
      const obj = JSON.parse(text);
      expect(obj.verdict).to.equal("ACCEPTED");
      expect(obj.recoveredSigner).to.equal(fx.wallet.address.toLowerCase());
      expect(obj.checks.signatureMatchesSigner).to.equal(true);
      expect(obj.checks.signerMatchesExpected).to.equal(true);
      expect(obj.checks.manifestBindsAttestation).to.equal(true);
    });

    it("output LEADS with the shared TRUST_NOTE + parcel caveat; never overclaims a delivery timestamp", async function () {
      const fx = await signFixture(THREE, "pva-trust");
      let out = "";
      runParcelVerifyAttest({ signed: fx.signedPath, stdout: (s) => (out += s) });
      expect(out.indexOf("TRUST:")).to.be.lessThan(out.indexOf("verify-attest:"));
      expect(PARCEL_VERIFY_ATTEST_TRUST_NOTE).to.contain(TRUST_NOTE); // shared note reused verbatim
      expect(PARCEL_VERIFY_ATTEST_TRUST_NOTE).to.contain(PARCEL_TRUST_NOTE); // parcel caveat reused verbatim
      expect(out).to.contain(TRUST_NOTE);
      expect(out).to.contain("P-3");
      expect(out).to.match(/not.*timestamp/i);
    });

    it("a malformed --signer is a usage error (exit 2), not a runtime throw", async function () {
      const fx = await signFixture(THREE, "pva-badsigner");
      const code = await capture(() =>
        main(["parcel", "verify-attest", fx.signedPath, "--signer", "0xnotanaddress"])
      ).then((c) => c.ret);
      expect(code).to.equal(2);
    });

    it("parser parity: unknown/incomplete flag, duplicate positional; missing <signed> is exit 2", async function () {
      expect(() => parseParcelVerifyAttestArgs(["/s", "--bogus"])).to.throw(/unknown flag/);
      expect(() => parseParcelVerifyAttestArgs(["/s", "/t"])).to.throw(/unexpected extra argument/);
      expect(() => parseParcelVerifyAttestArgs(["/s", "--manifest"])).to.throw(/--manifest requires a value/);
      expect(() => parseParcelVerifyAttestArgs(["/s", "--signer"])).to.throw(/--signer requires a value/);
      const code = await capture(() => main(["parcel", "verify-attest"])).then((c) => c.ret);
      expect(code).to.equal(2);
    });

    it("unknown parcel subcommand still hard-errors (exit 2) now that attest/verify-attest exist", async function () {
      const code = await capture(() => main(["parcel", "frobnicate"])).then((c) => c.ret);
      expect(code).to.equal(2);
    });
  });
});

// =================================================================================================
// T-19.2 — `vh parcel sign <manifest> --key-env <VAR> | --key-file <path> [--out <p>] [--json]`: read a
// HUMAN-supplied key, sign the UNSIGNED parcel attestation, write the signed container.
//
// CRITICAL: every key here is an EPHEMERAL, in-process `Wallet.createRandom()` — a TEST-ONLY key written
// ONLY to a TEMP env var / a TEMP file under the OS temp dir, NEVER the repo, NEVER a real key. NO network,
// NO provider anywhere in this suite (signing is purely offline EIP-191 personal_sign).
const {
  runParcelSign,
  SIGN_TRUST_NOTE: PARCEL_SIGN_TRUST_NOTE,
} = require("../cli/parcel");
const { cmdParcelSign, parseSignArgs } = require("../cli/vh");

describe("cli: vh parcel sign (T-19.2) — sign with a HUMAN-supplied key, EPHEMERAL test keys only", function () {
  let tmpDirs3 = [];
  function tmp3(prefix) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs3.push(d);
    return d;
  }
  // Each test that sets a temp env var records its NAME here so afterEach restores the environment (no
  // leaked key material persists past the test, pass or fail).
  let envVars = [];
  function setTempEnv(name, value) {
    envVars.push(name);
    process.env[name] = value;
  }
  afterEach(function () {
    for (const d of tmpDirs3) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs3 = [];
    for (const n of envVars) delete process.env[n];
    envVars = [];
  });

  // Build a parcel manifest from a fresh tree -> { manifestPath, manifest, canonical-unsigned }.
  function buildManifestFixture(files = THREE, prefix = "psign", parcel = META) {
    const dir = writeFiles(tmp3(prefix + "-tree-"), files);
    const manifestPath = path.join(tmp3(prefix + "-man-"), "p.json");
    runParcelBuild({ dir, out: manifestPath, parcel, stdout: () => {} });
    return { dir, manifestPath, manifest: readParcelManifest(manifestPath) };
  }

  it("--key-env signs; the container is ACCEPTED by `vh parcel verify-attest --signer <thatAddr> --manifest`", async function () {
    const fx = buildManifestFixture();
    const w = Wallet.createRandom(); // EPHEMERAL TEST-ONLY key — never persisted to the repo
    setTempEnv("VH_PARCEL_TEST_KEY", w.privateKey);
    const out = path.join(tmp3("psign-out-"), "signed.json");

    let printed = "";
    const r = await runParcelSign({
      manifest: fx.manifestPath,
      keyEnv: "VH_PARCEL_TEST_KEY",
      out,
      stdout: (s) => (printed += s),
    });
    expect(r.signer).to.equal(w.address.toLowerCase());
    expect(r.scheme).to.equal("eip191-personal-sign");
    // The success line names WHICH key signed (its public address) so the human can confirm.
    expect(printed).to.include(`signed by ${w.address.toLowerCase()}`);
    // The output NEVER contains the private key.
    expect(printed).to.not.include(w.privateKey);
    expect(fs.readFileSync(out, "utf8")).to.not.include(w.privateKey);

    // The EXISTING verify-attest accepts it unchanged — and pins the expected signer + binds the manifest.
    const va = runParcelVerifyAttest({
      signed: out,
      manifest: fx.manifestPath,
      signer: w.address,
      stdout: () => {},
    });
    expect(va.verdict).to.equal("ACCEPTED");
    expect(va.accepted).to.equal(true);
    expect(va.recoveredSigner).to.equal(w.address.toLowerCase());
    expect(va.checks.signatureMatchesSigner).to.equal(true);
    expect(va.checks.signerMatchesExpected).to.equal(true);
    expect(va.checks.manifestBindsAttestation).to.equal(true);
  });

  it("--key-file (a file the human created) signs and verify-attest ACCEPTS it", async function () {
    const fx = buildManifestFixture(undefined, "psign-file");
    const w = Wallet.createRandom(); // TEST-ONLY
    const keyDir = tmp3("psign-key-"); // a TEMP dir under the OS temp dir, NEVER the repo
    const keyPath = path.join(keyDir, "key.hex");
    fs.writeFileSync(keyPath, w.privateKey + "\n"); // trailing newline is tolerated
    const out = path.join(tmp3("psign-fout-"), "signed.json");

    const r = await runParcelSign({ manifest: fx.manifestPath, keyFile: keyPath, out, stdout: () => {} });
    expect(r.signer).to.equal(w.address.toLowerCase());

    const va = runParcelVerifyAttest({ signed: out, manifest: fx.manifestPath, signer: w.address, stdout: () => {} });
    expect(va.accepted).to.equal(true);
  });

  it("--json round-trips: prints ONLY public fields (signer, scheme, out) — NEVER the key", async function () {
    const fx = buildManifestFixture(undefined, "psign-json");
    const w = Wallet.createRandom(); // TEST-ONLY
    setTempEnv("VH_PARCEL_JSON_KEY", w.privateKey);
    const out = path.join(tmp3("psign-jout-"), "signed.json");

    let printed = "";
    await runParcelSign({
      manifest: fx.manifestPath,
      keyEnv: "VH_PARCEL_JSON_KEY",
      out,
      json: true,
      stdout: (s) => (printed += s),
    });
    const obj = JSON.parse(printed);
    expect(obj.signed).to.equal(true);
    expect(obj.signer).to.equal(w.address.toLowerCase());
    expect(obj.scheme).to.equal("eip191-personal-sign");
    expect(obj.out).to.equal(path.resolve(out));
    // With --out, the bytes live on disk; the JSON `container` field is null (no redundant copy).
    expect(obj.container).to.equal(null);
    // No key field anywhere in the JSON, and the raw key string never appears.
    expect(JSON.stringify(obj)).to.not.include(w.privateKey);
    expect(printed).to.not.include(w.privateKey);
  });

  it("--json WITHOUT --out NEVER drops the artifact: the canonical signed bytes ride in `container`, and verify-attest ACCEPTS them", async function () {
    const fx = buildManifestFixture(undefined, "psign-json-noout");
    const w = Wallet.createRandom(); // TEST-ONLY
    setTempEnv("VH_PARCEL_JSON_NOOUT_KEY", w.privateKey);

    let printed = "";
    const r = await runParcelSign({
      manifest: fx.manifestPath,
      keyEnv: "VH_PARCEL_JSON_NOOUT_KEY",
      // NO --out: the only place the signed container can live is the JSON output itself.
      json: true,
      stdout: (s) => (printed += s),
    });
    const obj = JSON.parse(printed);
    expect(obj.signed).to.equal(true);
    expect(obj.signer).to.equal(w.address.toLowerCase());
    expect(obj.out).to.equal(null);
    // The artifact is NOT dropped: `container` carries the EXACT canonical signed bytes the function built.
    expect(obj.container).to.be.a("string");
    expect(obj.container).to.equal(r.canonical);
    // No key ever leaks into the JSON.
    expect(printed).to.not.include(w.privateKey);
    expect(obj.container).to.not.include(w.privateKey);

    // Round-trip: write the carried bytes to a TEMP file and confirm the EXISTING verify-attest ACCEPTS them.
    const reconstructed = path.join(tmp3("psign-json-noout-rt-"), "signed.json");
    fs.writeFileSync(reconstructed, obj.container);
    const va = runParcelVerifyAttest({
      signed: reconstructed,
      manifest: fx.manifestPath,
      signer: w.address,
      stdout: () => {},
    });
    expect(va.accepted).to.equal(true);
    expect(va.recoveredSigner).to.equal(w.address.toLowerCase());
  });

  it("the signed container output never contains the private key (on disk)", async function () {
    const fx = buildManifestFixture(undefined, "psign-leak");
    const w = Wallet.createRandom(); // TEST-ONLY
    setTempEnv("VH_PARCEL_LEAK_KEY", w.privateKey);
    const out = path.join(tmp3("psign-lout-"), "signed.json");
    await runParcelSign({ manifest: fx.manifestPath, keyEnv: "VH_PARCEL_LEAK_KEY", out, stdout: () => {} });
    const bytes = fs.readFileSync(out, "utf8");
    expect(bytes).to.not.include(w.privateKey);
    // Also not the bare (0x-stripped) form.
    expect(bytes).to.not.include(w.privateKey.slice(2));
    // It DOES contain the public signer address (so verify-attest can recover/confirm).
    expect(bytes).to.include(w.address.toLowerCase());
  });

  describe("HARD-ERRORS before signing, and NEVER leak the key", function () {
    it("NEITHER key source: exit 2, no output written", async function () {
      const fx = buildManifestFixture(undefined, "psign-none");
      const out = path.join(tmp3("psign-none-out-"), "signed.json");
      const code = await cmdParcelSign([fx.manifestPath, "--out", out]);
      expect(code).to.equal(2);
      expect(fs.existsSync(out)).to.equal(false);
    });

    it("BOTH key sources: exit 2, no output written", async function () {
      const fx = buildManifestFixture(undefined, "psign-both");
      const w = Wallet.createRandom(); // TEST-ONLY
      setTempEnv("VH_PARCEL_BOTH_KEY", w.privateKey);
      const keyPath = path.join(tmp3("psign-both-key-"), "k.hex");
      fs.writeFileSync(keyPath, w.privateKey);
      const out = path.join(tmp3("psign-both-out-"), "signed.json");
      const code = await cmdParcelSign([
        fx.manifestPath,
        "--key-env",
        "VH_PARCEL_BOTH_KEY",
        "--key-file",
        keyPath,
        "--out",
        out,
      ]);
      expect(code).to.equal(2);
      expect(fs.existsSync(out)).to.equal(false);
    });

    it("missing env var: throws BEFORE signing, no output, message names only the SOURCE (not the key)", async function () {
      const fx = buildManifestFixture(undefined, "psign-missing");
      const out = path.join(tmp3("psign-missing-out-"), "signed.json");
      let threw;
      try {
        await runParcelSign({ manifest: fx.manifestPath, keyEnv: "VH_DEFINITELY_UNSET_KEY_XYZ", out, stdout: () => {} });
        threw = null;
      } catch (e) {
        threw = e;
      }
      expect(threw).to.be.an("error");
      expect(threw.message).to.match(/VH_DEFINITELY_UNSET_KEY_XYZ.*not set|not set.*VH_DEFINITELY_UNSET_KEY_XYZ/);
      expect(fs.existsSync(out)).to.equal(false);
    });

    it("unreadable key file: throws BEFORE signing, no output, message names the PATH (not the key)", async function () {
      const fx = buildManifestFixture(undefined, "psign-badfile");
      const out = path.join(tmp3("psign-badfile-out-"), "signed.json");
      let threw;
      try {
        await runParcelSign({ manifest: fx.manifestPath, keyFile: "/no/such/key/file.hex", out, stdout: () => {} });
        threw = null;
      } catch (e) {
        threw = e;
      }
      expect(threw).to.be.an("error");
      expect(threw.message).to.include("/no/such/key/file.hex");
      expect(fs.existsSync(out)).to.equal(false);
    });

    it("a malformed key HARD-ERRORS without writing output and WITHOUT leaking the key value", async function () {
      const fx = buildManifestFixture(undefined, "psign-malformed");
      const malformed = "this-is-not-a-private-key";
      setTempEnv("VH_PARCEL_MALFORMED_KEY", malformed);
      const out = path.join(tmp3("psign-malformed-out-"), "signed.json");
      let threw;
      try {
        await runParcelSign({ manifest: fx.manifestPath, keyEnv: "VH_PARCEL_MALFORMED_KEY", out, stdout: () => {} });
        threw = null;
      } catch (e) {
        threw = e;
      }
      expect(threw).to.be.an("error");
      // Names the SOURCE (env:VAR), NEVER the malformed value itself.
      expect(threw.message).to.include("env:VH_PARCEL_MALFORMED_KEY");
      expect(threw.message).to.not.include(malformed);
      expect(fs.existsSync(out)).to.equal(false);
    });

    it("an all-zero key is rejected (not a usable signer), no output, no leak", async function () {
      const fx = buildManifestFixture(undefined, "psign-zero");
      const zero = "0x" + "00".repeat(32);
      setTempEnv("VH_PARCEL_ZERO_KEY", zero);
      const out = path.join(tmp3("psign-zero-out-"), "signed.json");
      let threw;
      try {
        await runParcelSign({ manifest: fx.manifestPath, keyEnv: "VH_PARCEL_ZERO_KEY", out, stdout: () => {} });
        threw = null;
      } catch (e) {
        threw = e;
      }
      expect(threw).to.be.an("error");
      expect(threw.message).to.match(/all-zero/);
      expect(fs.existsSync(out)).to.equal(false);
    });
  });

  describe("CLI exit codes + parser parity", function () {
    it("a clean sign via the cmd handler returns exit 0", async function () {
      const fx = buildManifestFixture(undefined, "psign-cli-ok");
      const w = Wallet.createRandom(); // TEST-ONLY
      setTempEnv("VH_PARCEL_CLI_KEY", w.privateKey);
      const out = path.join(tmp3("psign-cli-out-"), "signed.json");
      let printed = "";
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = (s) => ((printed += s), true);
      let code;
      try {
        code = await cmdParcelSign([fx.manifestPath, "--key-env", "VH_PARCEL_CLI_KEY", "--out", out]);
      } finally {
        process.stdout.write = orig;
      }
      expect(code).to.equal(0);
      expect(fs.existsSync(out)).to.equal(true);
      expect(printed).to.not.include(w.privateKey);
    });

    it("missing <manifest> is exit 2; a malformed/zero key surfaces as exit 1 (runtime)", async function () {
      // missing positional manifest -> usage error 2
      const code2 = await cmdParcelSign(["--key-env", "VH_PARCEL_X"]);
      expect(code2).to.equal(2);
      // present manifest + a present-but-bad key -> runtime error 1 (not a usage error)
      const fx = buildManifestFixture(undefined, "psign-rt");
      setTempEnv("VH_PARCEL_BADV", "nope");
      const out = path.join(tmp3("psign-rt-out-"), "signed.json");
      const code1 = await cmdParcelSign([fx.manifestPath, "--key-env", "VH_PARCEL_BADV", "--out", out]);
      expect(code1).to.equal(1);
      expect(fs.existsSync(out)).to.equal(false);
    });

    it("parser parity: unknown/incomplete flag, duplicate positional hard-error", function () {
      expect(() => parseSignArgs(["/m", "--bogus"])).to.throw(/unknown flag/);
      expect(() => parseSignArgs(["/m", "/n"])).to.throw(/unexpected extra argument/);
      expect(() => parseSignArgs(["/m", "--key-env"])).to.throw(/--key-env requires a value/);
      expect(() => parseSignArgs(["/m", "--key-file"])).to.throw(/--key-file requires a value/);
      expect(() => parseSignArgs(["/m", "--out"])).to.throw(/--out requires a value/);
    });

    it("a typo'd flag via the cmd handler is exit 2 (a typo never silently signs)", async function () {
      const fx = buildManifestFixture(undefined, "psign-typo");
      setTempEnv("VH_PARCEL_TYPO_KEY", Wallet.createRandom().privateKey);
      const code = await cmdParcelSign([fx.manifestPath, "--key-env", "VH_PARCEL_TYPO_KEY", "--nope"]);
      expect(code).to.equal(2);
    });

    it("the SIGN_TRUST_NOTE carries the P-3 posture (NOT a trusted timestamp; key YOU supplied)", function () {
      expect(PARCEL_SIGN_TRUST_NOTE).to.match(/NOT an independent, trusted TIMESTAMP/);
      expect(PARCEL_SIGN_TRUST_NOTE).to.include("P-3");
      expect(PARCEL_SIGN_TRUST_NOTE).to.match(/key YOU supplied/);
    });
  });

  it("leaves ZERO key files / signed containers in the repo working tree (all side effects in temp dirs)", function () {
    expect(fs.existsSync(path.join(process.cwd(), "signed.json"))).to.equal(false);
    expect(fs.existsSync(path.join(process.cwd(), "key.hex"))).to.equal(false);
    expect(fs.existsSync(path.join(process.cwd(), "p.json"))).to.equal(false);
  });
});

// =====================================================================================================
// verify-timestamp (T-20.3) — the OFFLINE independent-timestamp verifier for ProofParcel. =============
//   THIN parallel to the dataset suite: a MINTED-token parcel container verifies ACCEPTED and reports the
//   asserted genTime/serial/policy; `--manifest` binds to the recipient's OWN parcel (a DIFFERENT manifest
//   REJECTS); a tampered token / mismatched digest / edited embedded attestation each REJECT with the 3-exit;
//   `--json` round-trips; the offline verify needs no network; the suite leaves the tree clean.
// =====================================================================================================

const crypto = require("crypto");
const {
  buildTimestampedParcelAttestation,
  serializeTimestampedParcelAttestation,
  runParcelVerifyTimestamp,
  verifyTimestampedParcelAttestation,
  PARCEL_VERIFY_TIMESTAMP_TRUST_NOTE,
} = require("../cli/parcel");
const { OID: RPT_OID } = require("../cli/core/rfc3161");
const { cmdParcelVerifyTimestamp } = require("../cli/vh");

// ---- TEST-ONLY DER token minter (mock TSA; NO real TSA/key/funds/network). --------------------------
function rptDerLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const b = [];
  let x = n;
  while (x > 0) {
    b.unshift(x & 0xff);
    x = Math.floor(x / 256);
  }
  return Buffer.from([0x80 | b.length, ...b]);
}
function rptTlv(tag, v) {
  v = Buffer.isBuffer(v) ? v : Buffer.from(v);
  return Buffer.concat([Buffer.from([tag]), rptDerLen(v.length), v]);
}
const rptSeq = (...p) => rptTlv(0x30, Buffer.concat(p));
const rptSet = (...p) => rptTlv(0x31, Buffer.concat(p));
const rptOct = (v) => rptTlv(0x04, v);
const rptCtx0 = (v) => rptTlv(0xa0, v);
function rptInt(v) {
  let big = BigInt(v);
  let h = big.toString(16);
  if (h.length % 2) h = "0" + h;
  let by = Buffer.from(h, "hex");
  if (by.length === 0) by = Buffer.from([0]);
  if (by[0] & 0x80) by = Buffer.concat([Buffer.from([0]), by]);
  return rptTlv(0x02, by);
}
function rptOid(d) {
  const a = d.split(".").map((s) => parseInt(s, 10));
  const o = [40 * a[0] + a[1]];
  for (let i = 2; i < a.length; i++) {
    let v = a[i];
    const s = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) {
      s.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    o.push(...s);
  }
  return rptTlv(0x06, Buffer.from(o));
}
const rptGt = (s) => rptTlv(0x18, Buffer.from(s, "ascii"));
function mintParcelTestToken(opts = {}) {
  const digestHex = (opts.digestHex || "").replace(/^0x/i, "").toLowerCase();
  const hashOID = opts.hashOID || RPT_OID.sha256;
  const genTime = opts.genTime || "20260623120000Z";
  const serial = opts.serial !== undefined ? opts.serial : 7;
  const policyOID = opts.policyOID || "1.2.3.4.5";
  const ha = rptSeq(rptOid(hashOID), Buffer.from([0x05, 0x00]));
  const mi = rptSeq(ha, rptOct(Buffer.from(digestHex, "hex")));
  const ti = rptSeq(rptInt(1), rptOid(policyOID), mi, rptInt(serial), rptGt(genTime));
  const encap = rptSeq(rptOid(RPT_OID.tstInfo), rptCtx0(rptOct(ti)));
  const sd = rptSeq(rptInt(3), rptSet(rptSeq(rptOid(hashOID), Buffer.from([0x05, 0x00]))), encap);
  return rptSeq(rptOid(RPT_OID.signedData), rptCtx0(sd));
}

describe("cli: vh parcel verify-timestamp (T-20.3) — OFFLINE independent-timestamp verifier", function () {
  // Build a parcel + its timestamped container over a MINTED token bound to the canonical sha256 digest.
  function fixture(files, prefix, parcelBlock, tokenOpts) {
    const dir = writeFiles(tmp((prefix || "pvt") + "-tree-"), files);
    const manifestPath = path.join(tmp((prefix || "pvt") + "-man-"), "manifest.json");
    runParcelBuild({ dir, out: manifestPath, parcel: parcelBlock, stdout: () => {} });
    const manifest = readParcelManifest(manifestPath);
    const unsigned = buildParcelAttestation(manifest);
    const canonical = serializeParcelAttestation(unsigned);
    const digest = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
    const token = mintParcelTestToken({ digestHex: digest, ...(tokenOpts || {}) });
    const container = buildTimestampedParcelAttestation({ attestation: unsigned, token });
    const containerPath = path.join(tmp((prefix || "pvt") + "-c-"), "ts.json");
    fs.writeFileSync(containerPath, serializeTimestampedParcelAttestation(container));
    return { dir, manifestPath, manifest, unsigned, canonical, digest, container, containerPath };
  }

  it("a MINTED-token parcel container verifies ACCEPTED and reports the asserted genTime/serial/policy", async function () {
    const f = fixture(
      { "data.csv": "1,2,3" },
      "pok",
      { parcelId: "PO-42", sender: "vendor", recipient: "buyer" },
      { genTime: "20260201000000Z", serial: 555, policyOID: "1.3.6.1.4.1.13762.3" }
    );
    const { ret, out } = await capture(() => runParcelVerifyTimestamp({ container: f.containerPath }));
    expect(ret.verdict).to.equal("ACCEPTED");
    expect(ret.accepted).to.equal(true);
    expect(ret.genTime).to.equal("2026-02-01T00:00:00Z");
    expect(ret.serialNumber.decimal).to.equal("555");
    expect(ret.policyOID).to.equal("1.3.6.1.4.1.13762.3");
    expect(ret.digest).to.equal(f.digest);
    expect(out).to.include("ACCEPTED means an RFC-3161");
    expect(out).to.include("verify-timestamp: ACCEPTED");
  });

  it("the exit code is 0 on ACCEPTED via the cmd handler", async function () {
    const f = fixture({ "x.bin": "X" }, "pexit0");
    const { ret } = await capture(() => cmdParcelVerifyTimestamp([f.containerPath]));
    expect(ret).to.equal(0);
  });

  describe("--manifest binds the timestamp to the recipient's OWN parcel", function () {
    it("the SAME manifest ACCEPTS with the binding check PASS", async function () {
      const f = fixture({ "data.csv": "1,2,3" }, "pbind-ok", { parcelId: "PO-1" });
      const { ret } = await capture(() =>
        runParcelVerifyTimestamp({ container: f.containerPath, manifest: f.manifestPath })
      );
      expect(ret.accepted).to.equal(true);
      expect(ret.checks.manifestBindsAttestation).to.equal(true);
    });

    it("a DIFFERENT manifest REJECTS (the token stamped a different parcel identity)", async function () {
      const f = fixture({ "data.csv": "1,2,3" }, "pbind-diff", { parcelId: "PO-1" });
      const other = fixture({ "data.csv": "9,9,9" }, "pbind-other", { parcelId: "PO-1" });
      const { ret } = await capture(() =>
        cmdParcelVerifyTimestamp([f.containerPath, "--manifest", other.manifestPath])
      );
      expect(ret).to.equal(3);
    });
  });

  describe("a tampered token / mismatched digest / edited embedded attestation each REJECT (3-exit)", function () {
    it("a token binding a DIFFERENT digest REJECTS", async function () {
      const f = fixture({ "a.txt": "AAA" }, "ptok-diff");
      const wrong = mintParcelTestToken({ digestHex: "c".repeat(64) });
      const obj = JSON.parse(fs.readFileSync(f.containerPath, "utf8"));
      obj.timestamp.token = require("../cli/core/rfc3161")._internal.toBuf(wrong).toString("base64");
      const p = path.join(tmp("ptok-c-"), "c.json");
      fs.writeFileSync(p, JSON.stringify(obj));
      const { ret } = await capture(() => cmdParcelVerifyTimestamp([p]));
      expect(ret).to.equal(3);
    });

    it("a mismatched recorded digest REJECTS", async function () {
      const f = fixture({ "a.txt": "AAA" }, "pdig");
      const obj = JSON.parse(fs.readFileSync(f.containerPath, "utf8"));
      obj.timestamp.digest = "d".repeat(64);
      const p = path.join(tmp("pdig-c-"), "c.json");
      fs.writeFileSync(p, JSON.stringify(obj));
      const { ret } = await capture(() => cmdParcelVerifyTimestamp([p]));
      expect(ret).to.equal(3);
    });

    it("an EDITED embedded attestation REJECTS (wrap-don't-edit)", async function () {
      const f = fixture({ "a.txt": "AAA" }, "pedit");
      const obj = JSON.parse(fs.readFileSync(f.containerPath, "utf8"));
      const edited = JSON.parse(obj.attestation);
      edited.root = "0x" + "0".repeat(64);
      obj.attestation = JSON.stringify(edited);
      const p = path.join(tmp("pedit-c-"), "c.json");
      fs.writeFileSync(p, JSON.stringify(obj));
      const { ret } = await capture(() => runParcelVerifyTimestamp({ container: p }));
      expect(ret.accepted).to.equal(false);
      expect(ret.checks.structureAndBinding).to.equal(false);
    });

    it("a DATASET timestamped container does NOT cross-validate as a parcel one (wrong kind REJECTS)", async function () {
      // Take a parcel container and flip its kind to the dataset kind -> the parcel reader rejects it.
      const f = fixture({ "a.txt": "AAA" }, "pcross");
      const obj = JSON.parse(fs.readFileSync(f.containerPath, "utf8"));
      obj.kind = "verifyhash.dataset-attestation-timestamped";
      const p = path.join(tmp("pcross-c-"), "c.json");
      fs.writeFileSync(p, JSON.stringify(obj));
      const { ret } = await capture(() => cmdParcelVerifyTimestamp([p]));
      expect(ret).to.equal(3);
    });
  });

  describe("--json round-trips the verdict", function () {
    it("ACCEPTED --json parses and carries the asserted facts", async function () {
      const f = fixture({ "a.txt": "AAA" }, "pjson", undefined, { serial: 3, genTime: "20251231235959Z" });
      const { out } = await capture(() =>
        runParcelVerifyTimestamp({ container: f.containerPath, manifest: f.manifestPath, json: true })
      );
      const parsed = JSON.parse(out);
      expect(parsed.verdict).to.equal("ACCEPTED");
      expect(parsed.checks.manifestBindsAttestation).to.equal(true);
      expect(parsed.genTime).to.equal("2025-12-31T23:59:59Z");
      expect(parsed.serialNumber.decimal).to.equal("3");
    });
  });

  it("the bounded TRUST_NOTE disavows the cert chain and reuses the shared TRUST_NOTE + parcel caveat", function () {
    expect(PARCEL_VERIFY_TIMESTAMP_TRUST_NOTE).to.match(/ACCEPTED means an RFC-3161/);
    expect(PARCEL_VERIFY_TIMESTAMP_TRUST_NOTE).to.match(/does NOT validate the TSA's certificate chain/);
    expect(PARCEL_VERIFY_TIMESTAMP_TRUST_NOTE).to.match(/NEVER claims "delivered\/unaltered since date T"/);
    expect(PARCEL_VERIFY_TIMESTAMP_TRUST_NOTE).to.include(TRUST_NOTE);
    expect(PARCEL_VERIFY_TIMESTAMP_TRUST_NOTE).to.include(PARCEL_TRUST_NOTE);
  });

  describe("usage / parser parity", function () {
    it("a missing <container> is a usage error (exit 2)", async function () {
      const { ret } = await capture(() => cmdParcelVerifyTimestamp([]));
      expect(ret).to.equal(2);
    });
    it("an unknown flag is a usage error (exit 2)", async function () {
      const f = fixture({ "a.txt": "AAA" }, "ptypo");
      const { ret } = await capture(() => cmdParcelVerifyTimestamp([f.containerPath, "--nope"]));
      expect(ret).to.equal(2);
    });
    it("a missing container FILE is a runtime error (exit 1), distinct from a clean REJECT", async function () {
      const { ret } = await capture(() =>
        cmdParcelVerifyTimestamp([path.join(os.tmpdir(), "definitely-missing-pvt.json")])
      );
      expect(ret).to.equal(1);
    });
  });

  it("the offline verify needs no network (no provider/RPC env required)", async function () {
    const f = fixture({ "a.txt": "AAA" }, "poffline");
    const savedRpc = process.env.VH_RPC_URL;
    delete process.env.VH_RPC_URL;
    try {
      const { ret } = await capture(() => runParcelVerifyTimestamp({ container: f.containerPath }));
      expect(ret.accepted).to.equal(true);
    } finally {
      if (savedRpc !== undefined) process.env.VH_RPC_URL = savedRpc;
    }
  });

  it("verifyTimestampedParcelAttestation is PURE over an already-parsed container", function () {
    const f = fixture({ "a.txt": "AAA" }, "ppure");
    const obj = JSON.parse(fs.readFileSync(f.containerPath, "utf8"));
    const r = verifyTimestampedParcelAttestation({ container: obj });
    expect(r.accepted).to.equal(true);
  });
});

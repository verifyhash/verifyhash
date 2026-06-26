"use strict";

// test/verifier.reproduce.test.js — T-54.1: PROVE the third-party-runnable REPRODUCE-AND-ATTEST mode
// (`node verifier/build-standalone.js --check`).
//
// WHY THIS TEST EXISTS — "who verifies the verifier?"
//   The free standalone verifier is the FUNNEL: a cold prospect's security team is asked to RUN
//   `verify-vh-standalone.js` and trust its verdict (P-8 step 3a/3b). The bundle ships beside a `.sha256`
//   sidecar — but that sidecar comes FROM THE SAME PLACE as the bundle, so on its own it proves only that the
//   file survived transport (a CIRCULAR check), not that the bundle is the audited in-tree source. `--check`
//   closes that gap: it RE-COMPILES each bundle from the in-tree source a skeptic can READ, recomputes the
//   published checksum from those bytes, and asserts the COMMITTED bundle + sidecar are byte-for-byte what
//   that source compiles to. This suite makes that promise TRUE in code so the docs can never silently drift:
//
//   (1) on the CLEAN tree, `--check` exits 0 and prints MATCH for BOTH bundles AND BOTH sidecars
//       (recomputed hex == published hex, recomputed bytes == committed bytes).
//   (2) corrupting a COPIED `dist` bundle by ONE byte (in a temp tree) makes `--check` exit 1 with MISMATCH
//       naming that target — and not the untouched ones.
//   (3) corrupting a COPIED `.sha256` sidecar makes `--check` exit 1 with MISMATCH naming that sidecar.
//   (4) the default no-flag build still emits the four files BYTE-IDENTICALLY (regression-pinned against the
//       committed dist).
//   (5) `--check` opens NO network (run under the EPIC-31 network-poison guard) and writes NOTHING under the
//       source tree (the verifier/ tree is byte-identical before and after a `--check`).
//
// All work lands under a throwaway temp dir cleaned in afterEach; the working tree (cwd) is asserted
// untouched. `--check` is spawned in a CHILD PROCESS so we exercise the REAL CLI entrypoint + exit code.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const builder = require("../verifier/build-standalone");

const VERIFIER_DIR = path.resolve(__dirname, "..", "verifier");
const BUILDER_PATH = path.join(VERIFIER_DIR, "build-standalone.js");

// The committed artifacts this task pins: two bundles + two sidecars + the build-provenance manifest (T-54.2).
const ARTIFACTS = {
  verifyBundle: path.join(VERIFIER_DIR, "dist", "verify-vh-standalone.js"),
  verifySidecar: path.join(VERIFIER_DIR, "dist", "verify-vh-standalone.js.sha256"),
  sealBundle: path.join(VERIFIER_DIR, "dist", "seal-vh-standalone.js"),
  sealSidecar: path.join(VERIFIER_DIR, "dist", "seal-vh-standalone.js.sha256"),
  provenance: path.join(VERIFIER_DIR, "dist", "BUILD-PROVENANCE.json"),
};

describe("verifier reproduce-and-attest: `build-standalone.js --check` (T-54.1)", function () {
  // Copying the verifier tree + child spawns is a touch slower than a unit test; give headroom.
  this.timeout(60000);

  let tmpDirs;
  let cwdBefore;

  beforeEach(function () {
    tmpDirs = [];
    cwdBefore = fs.readdirSync(process.cwd()).sort();
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });

  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-reproduce-"));
    tmpDirs.push(d);
    return d;
  }

  // Copy the WHOLE verifier/ tree into a fresh temp dir so we can corrupt a COPY of dist and run THAT copy's
  // builder with `--check` — proving the third-party reproduce path on a tree the test controls. Returns the
  // copied verifier dir.
  function copyVerifierTree() {
    const root = mkTmp();
    const dst = path.join(root, "verifier");
    fs.cpSync(VERIFIER_DIR, dst, { recursive: true });
    return dst;
  }

  // Run `<verifierDir>/build-standalone.js --check` in a CHILD PROCESS with NODE_PATH cleared. Returns
  // spawnSync's { status, stdout, stderr, error }.
  function runCheck(verifierDir, extraArgs, opts) {
    const args = [path.join(verifierDir, "build-standalone.js"), "--check", ...(extraArgs || [])];
    return spawnSync(process.execPath, args, {
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "" },
      ...(opts || {}),
    });
  }

  // A snapshot of every file under a tree (relpath -> sha256 hex), so we can prove a `--check` wrote NOTHING.
  function hashTree(root) {
    const out = {};
    function walk(dir) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else out[path.relative(root, full)] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      }
    }
    walk(root);
    return out;
  }

  function sha256Hex(buf) {
    return crypto.createHash("sha256").update(buf).digest("hex");
  }

  // ============================================================================================
  // (1) CLEAN TREE — `--check` exits 0 and prints MATCH for BOTH bundles AND BOTH sidecars.
  // ============================================================================================
  describe("(1) clean tree: exit 0, MATCH for both bundles and both sidecars", function () {
    it("`--check` on the real committed tree exits 0 with no MISMATCH and all MATCH lines", function () {
      const res = runCheck(VERIFIER_DIR);
      expect(res.error, "no spawn error").to.equal(undefined);
      expect(res.status, `exit 0 (out: ${res.stdout}${res.stderr})`).to.equal(0);
      const out = res.stdout;
      // No MISMATCH anywhere; the summary line confirms ALL MATCH.
      expect(out, "no MISMATCH on the clean tree").to.not.match(/MISMATCH/);
      expect(out).to.match(/ALL MATCH/);
      // Both bundles AND both sidecars print a MATCH line, naming each of the four basenames.
      expect(out).to.match(/\[MATCH\] bundle  dist\/verify-vh-standalone\.js:/);
      expect(out).to.match(/\[MATCH\] sidecar dist\/verify-vh-standalone\.js\.sha256:/);
      expect(out).to.match(/\[MATCH\] bundle  dist\/seal-vh-standalone\.js:/);
      expect(out).to.match(/\[MATCH\] sidecar dist\/seal-vh-standalone\.js\.sha256:/);
      // The build-provenance manifest AND the per-source chain it pins also print MATCH (T-54.2).
      expect(out).to.match(/\[MATCH\] manifest dist\/BUILD-PROVENANCE\.json:/);
      expect(out).to.match(/\[MATCH\] sources->manifest:/);
      // Each bundle's OWN embedded provenance (the self-attest surface that travels with the file) also MATCHes.
      expect(out).to.match(/\[MATCH\] embedded dist\/verify-vh-standalone\.js:/);
      expect(out).to.match(/\[MATCH\] embedded dist\/seal-vh-standalone\.js:/);
      // Every line is a MATCH; there are no MISMATCH lines at all on the clean tree.
      expect((out.match(/\[MISMATCH\]/g) || []).length, "zero MISMATCH lines").to.equal(0);
      // The fixed clean-tree report: 2 bundles + 2 sidecars + 2 source-presence + 2 embedded + manifest +
      // chain = 10 MATCHes.
      expect((out.match(/\[MATCH\]/g) || []).length, "ten MATCH lines").to.equal(10);
    });

    it("each printed MATCH hex EQUALS the SHA-256 of the committed bundle it pins", function () {
      const res = runCheck(VERIFIER_DIR);
      expect(res.status).to.equal(0);
      // The recomputed hex the tool prints must be the actual sha256 of the committed bundle bytes — i.e.
      // the reproduce path is honest, not a self-referential echo.
      const verifyHex = sha256Hex(fs.readFileSync(ARTIFACTS.verifyBundle));
      const sealHex = sha256Hex(fs.readFileSync(ARTIFACTS.sealBundle));
      expect(res.stdout, "prints the verify bundle's real sha256").to.include(verifyHex);
      expect(res.stdout, "prints the seal bundle's real sha256").to.include(sealHex);
      // ...and those equal the committed sidecars' published hex (recomputed hex == published hex).
      expect(fs.readFileSync(ARTIFACTS.verifySidecar, "utf8").trim().split(/\s+/)[0]).to.equal(verifyHex);
      expect(fs.readFileSync(ARTIFACTS.sealSidecar, "utf8").trim().split(/\s+/)[0]).to.equal(sealHex);
    });

    it("the in-process checkTarget() agrees with the CLI (both targets ok on the clean tree)", function () {
      for (const t of [builder.TARGETS.verify, builder.TARGETS.seal]) {
        const r = builder.checkTarget(t);
        expect(r.ok, `${t.name} reproduces`).to.equal(true);
        expect(r.bundle.ok && r.sidecar.ok && r.sources.ok, `${t.name} bundle+sidecar+sources ok`).to.equal(true);
        expect(r.expectedHex).to.equal(sha256Hex(fs.readFileSync(t.outPath)));
      }
    });

    it("the in-process checkProvenance() reproduces the manifest and attests every inlined source hash", function () {
      const r = builder.checkProvenance();
      expect(r.ok, "manifest + chain reproduce on the clean tree").to.equal(true);
      expect(r.manifest.ok, "committed manifest reproduces from source").to.equal(true);
      expect(r.chain.ok, "every inlined source hashes to its manifest pin").to.equal(true);
      expect(r.chain.offenders, "no offending source file").to.deep.equal([]);
    });

    it("`build-provenance.json` is the committed text the builder recomputes, and pins each source's REAL sha256", function () {
      // The committed manifest equals what buildProvenanceText() recomputes (byte-for-byte), so it cannot rot.
      const committed = fs.readFileSync(ARTIFACTS.provenance, "utf8");
      expect(committed, "committed manifest == recomputed manifest").to.equal(builder.buildProvenanceText());

      const obj = JSON.parse(committed);
      expect(obj.schema, "schema tag pinned").to.equal(builder.PROVENANCE_SCHEMA);

      // Every NON-synthetic module the manifest lists must pin the ACTUAL sha256 of the on-disk source file —
      // i.e. the provenance is honest (a skeptic re-hashing the file they audited finds exactly this hash).
      const normalize = (s) => s.replace(/\r\n/g, "\n").replace(/^#![^\n]*\n/, "");
      for (const target of Object.values(obj.targets)) {
        // The manifest's published bundle hash equals the real sha256 of the committed bundle it names.
        const bundlePath = path.join(VERIFIER_DIR, "dist", target.bundle);
        expect(target.bundleSha256, `${target.bundle} bundleSha256 is the real hash`).to.equal(
          sha256Hex(fs.readFileSync(bundlePath))
        );
        for (const mod of target.modules) {
          if (mod.synthetic) {
            // A synthetic module (the keccak shim) has no on-disk source — it is honestly flagged as such.
            expect(mod.sourceFile, "synthetic module has no sourceFile").to.equal(null);
            expect(mod.sourceSha256, "synthetic module has no sourceSha256").to.equal(null);
            continue;
          }
          const rel = mod.sourceFile.replace(/^verifier\//, "");
          const realHex = sha256Hex(Buffer.from(normalize(fs.readFileSync(path.join(VERIFIER_DIR, rel), "utf8")), "utf8"));
          expect(mod.sourceSha256, `${mod.sourceFile} pinned hash is its real sha256`).to.equal(realHex);
        }
      }
    });
  });

  // ============================================================================================
  // (2) ONE-BYTE BUNDLE CORRUPTION (in a COPIED tree) -> exit 1, MISMATCH naming that target.
  // ============================================================================================
  describe("(2) a corrupted copied dist BUNDLE -> exit 1, MISMATCH naming that target", function () {
    it("flipping one byte of the copied verify bundle makes `--check` exit 1 and name verify-vh-standalone.js", function () {
      const vdir = copyVerifierTree();
      const bundle = path.join(vdir, "dist", "verify-vh-standalone.js");
      const bytes = fs.readFileSync(bundle);
      bytes[0] = bytes[0] ^ 0xff; // ONE byte changed
      fs.writeFileSync(bundle, bytes);

      const res = runCheck(vdir);
      expect(res.error, "no spawn error").to.equal(undefined);
      expect(res.status, `tampered bundle -> exit 1 (out: ${res.stdout}${res.stderr})`).to.equal(1);
      const all = res.stdout + res.stderr;
      // The verify bundle is named in a MISMATCH line; the untouched seal bundle still MATCHes.
      expect(all).to.match(/\[MISMATCH\] bundle  dist\/verify-vh-standalone\.js:/);
      expect(all).to.match(/\[MATCH\] bundle  dist\/seal-vh-standalone\.js:/);
      // The sidecars themselves were NOT touched — but they still recompute against SOURCE, so they MATCH.
      expect(all).to.match(/\[MATCH\] sidecar dist\/verify-vh-standalone\.js\.sha256:/);
      expect(all).to.match(/MISMATCH — at least one committed bundle\/sidecar does NOT reproduce/);
    });

    it("flipping one byte of the copied SEAL bundle names seal-vh-standalone.js (target attribution is precise)", function () {
      const vdir = copyVerifierTree();
      const bundle = path.join(vdir, "dist", "seal-vh-standalone.js");
      const bytes = fs.readFileSync(bundle);
      bytes[bytes.length - 2] = bytes[bytes.length - 2] ^ 0x01; // one byte, away from the start
      fs.writeFileSync(bundle, bytes);

      const res = runCheck(vdir);
      expect(res.status, `tampered seal bundle -> exit 1 (out: ${res.stdout}${res.stderr})`).to.equal(1);
      const all = res.stdout + res.stderr;
      expect(all).to.match(/\[MISMATCH\] bundle  dist\/seal-vh-standalone\.js:/);
      // The untouched verify bundle is NOT falsely flagged.
      expect(all).to.match(/\[MATCH\] bundle  dist\/verify-vh-standalone\.js:/);
    });

    it("a MISSING copied bundle is also a MISMATCH (exit 1), not a crash", function () {
      const vdir = copyVerifierTree();
      fs.rmSync(path.join(vdir, "dist", "verify-vh-standalone.js"));
      const res = runCheck(vdir);
      expect(res.status, "missing bundle -> exit 1").to.equal(1);
      expect(res.stdout + res.stderr).to.match(/\[MISMATCH\] bundle  dist\/verify-vh-standalone\.js: .*MISSING/);
    });
  });

  // ============================================================================================
  // (3) SIDECAR CORRUPTION (in a COPIED tree) -> exit 1, MISMATCH naming that sidecar.
  // ============================================================================================
  describe("(3) a corrupted copied `.sha256` SIDECAR -> exit 1, MISMATCH naming that sidecar", function () {
    it("flipping a published hex digit in the copied verify sidecar makes `--check` exit 1 and name it", function () {
      const vdir = copyVerifierTree();
      const sidecar = path.join(vdir, "dist", "verify-vh-standalone.js.sha256");
      let s = fs.readFileSync(sidecar, "utf8");
      // Flip the first hex digit (still a valid sidecar line, just the WRONG hex) — the classic
      // "checksum says X but the bundle hashes to Y" attack the reproduce path must catch.
      s = (s[0] === "0" ? "1" : "0") + s.slice(1);
      fs.writeFileSync(sidecar, s);

      const res = runCheck(vdir);
      expect(res.error, "no spawn error").to.equal(undefined);
      expect(res.status, `tampered sidecar -> exit 1 (out: ${res.stdout}${res.stderr})`).to.equal(1);
      const all = res.stdout + res.stderr;
      expect(all).to.match(/\[MISMATCH\] sidecar dist\/verify-vh-standalone\.js\.sha256:/);
      // The bundle itself is untouched, so the bundle line still MATCHes — only the sidecar is flagged.
      expect(all).to.match(/\[MATCH\] bundle  dist\/verify-vh-standalone\.js:/);
      // And the seal pair is wholly untouched -> MATCH.
      expect(all).to.match(/\[MATCH\] sidecar dist\/seal-vh-standalone\.js\.sha256:/);
    });

    it("rewriting the sidecar's BASENAME (right hex, wrong name) is still a MISMATCH", function () {
      const vdir = copyVerifierTree();
      const sidecar = path.join(vdir, "dist", "seal-vh-standalone.js.sha256");
      const s = fs.readFileSync(sidecar, "utf8");
      // Same hex, but the basename swapped — the sidecar is no longer the canonical line for this bundle.
      fs.writeFileSync(sidecar, s.replace("seal-vh-standalone.js", "renamed.js"));
      const res = runCheck(vdir);
      expect(res.status, "wrong-basename sidecar -> exit 1").to.equal(1);
      expect(res.stdout + res.stderr).to.match(/\[MISMATCH\] sidecar dist\/seal-vh-standalone\.js\.sha256:/);
    });

    it("a MISSING copied sidecar is also a MISMATCH (exit 1)", function () {
      const vdir = copyVerifierTree();
      fs.rmSync(path.join(vdir, "dist", "seal-vh-standalone.js.sha256"));
      const res = runCheck(vdir);
      expect(res.status, "missing sidecar -> exit 1").to.equal(1);
      expect(res.stdout + res.stderr).to.match(/\[MISMATCH\] sidecar dist\/seal-vh-standalone\.js\.sha256: .*MISSING/);
    });
  });

  // ============================================================================================
  // (3b) A corrupted inlined SOURCE file (in a COPIED tree) -> exit 1, MISMATCH naming THAT source file.
  //      This is the leverage the build-provenance manifest adds: trust roots in the SOURCE a reviewer reads,
  //      so a one-byte change to a single `lib/*.js` is attributed to that exact file, not just an opaque
  //      "the bundle changed" — the actionable verdict a security/procurement reviewer wants.
  // ============================================================================================
  describe("(3b) a corrupted inlined SOURCE file -> exit 1, MISMATCH naming that source file", function () {
    it("flipping one byte of lib/merkle.js names verifier/lib/merkle.js in the sources->manifest line", function () {
      const vdir = copyVerifierTree();
      const src = path.join(vdir, "lib", "merkle.js");
      const bytes = fs.readFileSync(src);
      bytes[100] = bytes[100] ^ 0x01; // ONE byte of an audited source file
      fs.writeFileSync(src, bytes);

      const res = runCheck(vdir);
      expect(res.error, "no spawn error").to.equal(undefined);
      expect(res.status, `tampered source -> exit 1 (out: ${res.stdout}${res.stderr})`).to.equal(1);
      const all = res.stdout + res.stderr;
      // The source->manifest chain names the EXACT offending file against the committed manifest's pin.
      expect(all).to.match(/\[MISMATCH\] sources->manifest: .*verifier\/lib\/merkle\.js \(pinned [0-9a-f]+…, got [0-9a-f]+…\)/);
      // It also surfaces as a bundle MISMATCH (merkle is inlined into BOTH bundles), proving the two views agree.
      expect(all).to.match(/\[MISMATCH\] bundle  dist\/verify-vh-standalone\.js:/);
      expect(all).to.match(/\[MISMATCH\] bundle  dist\/seal-vh-standalone\.js:/);
    });

    it("a SOURCE file used by only ONE bundle (lib/canonical.js) names that file and is precise", function () {
      const vdir = copyVerifierTree();
      const src = path.join(vdir, "lib", "canonical.js");
      const s = fs.readFileSync(src, "utf8");
      // canonical.js is inlined ONLY into the verify bundle; the seal bundle never requires it.
      fs.writeFileSync(src, s + "\n// tamper\n");

      const res = runCheck(vdir);
      expect(res.status, "tampered canonical.js -> exit 1").to.equal(1);
      const all = res.stdout + res.stderr;
      expect(all).to.match(/\[MISMATCH\] sources->manifest: .*verifier\/lib\/canonical\.js/);
      // The verify bundle (which inlines canonical) MISMATCHes; the seal bundle (which does not) still MATCHes.
      expect(all).to.match(/\[MISMATCH\] bundle  dist\/verify-vh-standalone\.js:/);
      expect(all).to.match(/\[MATCH\] bundle  dist\/seal-vh-standalone\.js:/);
    });

    it("a MISSING inlined source file is named MISSING in the sources->manifest line (exit 1, not a crash)", function () {
      const vdir = copyVerifierTree();
      fs.rmSync(path.join(vdir, "lib", "revocation.js"));
      const res = runCheck(vdir);
      expect(res.status, "missing source -> exit 1").to.equal(1);
      const all = res.stdout + res.stderr;
      expect(all).to.match(/\[MISMATCH\] sources->manifest: .*verifier\/lib\/revocation\.js \(pinned [0-9a-f]+…, got MISSING\)/);
    });
  });

  // ============================================================================================
  // (3c) The committed BUILD-PROVENANCE.json manifest itself -> corrupting/deleting it is a MISMATCH.
  // ============================================================================================
  describe("(3c) a corrupted/missing committed manifest -> exit 1, MISMATCH naming the manifest", function () {
    it("flipping a pinned source hash inside the committed manifest is a MISMATCH (manifest + chain both flag it)", function () {
      const vdir = copyVerifierTree();
      const manifest = path.join(vdir, "dist", "BUILD-PROVENANCE.json");
      const obj = JSON.parse(fs.readFileSync(manifest, "utf8"));
      // Flip the pinned sha256 of merkle in the verify target (still valid JSON, just the WRONG pin) — the
      // "manifest claims source X hashes to H, but it hashes to H'" attack the chain must catch.
      const pin = obj.targets.verify.modules.find((m) => m.id === "merkle").sourceSha256;
      const flipped = (pin[0] === "0" ? "1" : "0") + pin.slice(1);
      const text = fs.readFileSync(manifest, "utf8").split(pin).join(flipped);
      fs.writeFileSync(manifest, text);

      const res = runCheck(vdir);
      expect(res.status, "tampered manifest -> exit 1").to.equal(1);
      const all = res.stdout + res.stderr;
      // The manifest no longer reproduces from source AND the (committed) pin no longer matches the real file.
      expect(all).to.match(/\[MISMATCH\] manifest dist\/BUILD-PROVENANCE\.json:/);
      expect(all).to.match(/\[MISMATCH\] sources->manifest: .*verifier\/lib\/merkle\.js/);
    });

    it("a MISSING committed manifest is a MISMATCH (exit 1), not a crash", function () {
      const vdir = copyVerifierTree();
      fs.rmSync(path.join(vdir, "dist", "BUILD-PROVENANCE.json"));
      const res = runCheck(vdir);
      expect(res.status, "missing manifest -> exit 1").to.equal(1);
      expect(res.stdout + res.stderr).to.match(/\[MISMATCH\] manifest dist\/BUILD-PROVENANCE\.json: .*MISSING/);
    });
  });

  // ============================================================================================
  // (4) DEFAULT NO-FLAG BUILD still emits the FIVE files BYTE-IDENTICALLY (regression-pinned).
  // ============================================================================================
  describe("(4) default no-flag build emits the five files byte-identically (regression pin)", function () {
    it("running the builder with NO flag in a copied tree reproduces all five committed files byte-for-byte", function () {
      // Take a copied tree, DELETE its dist, run the no-flag build, and assert the freshly emitted five files
      // are byte-identical to the committed originals — i.e. the default build path is unchanged by `--check`
      // and the build-provenance manifest is part of the deterministic, regression-pinned output.
      const vdir = copyVerifierTree();
      fs.rmSync(path.join(vdir, "dist"), { recursive: true, force: true });
      const res = spawnSync(process.execPath, [path.join(vdir, "build-standalone.js")], {
        encoding: "utf8",
        env: { ...process.env, NODE_PATH: "" },
      });
      expect(res.error, "no spawn error").to.equal(undefined);
      expect(res.status, `default build exits 0 (out: ${res.stdout}${res.stderr})`).to.equal(0);

      const pairs = [
        ["dist/verify-vh-standalone.js", ARTIFACTS.verifyBundle],
        ["dist/verify-vh-standalone.js.sha256", ARTIFACTS.verifySidecar],
        ["dist/seal-vh-standalone.js", ARTIFACTS.sealBundle],
        ["dist/seal-vh-standalone.js.sha256", ARTIFACTS.sealSidecar],
        ["dist/BUILD-PROVENANCE.json", ARTIFACTS.provenance],
      ];
      for (const [rel, committed] of pairs) {
        const fresh = fs.readFileSync(path.join(vdir, rel));
        expect(fresh, `${rel} byte-identical to committed`).to.deep.equal(fs.readFileSync(committed));
      }
    });

    it("after a fresh no-flag build, `--check` on that tree passes (the two paths agree)", function () {
      const vdir = copyVerifierTree();
      fs.rmSync(path.join(vdir, "dist"), { recursive: true, force: true });
      spawnSync(process.execPath, [path.join(vdir, "build-standalone.js")], {
        encoding: "utf8",
        env: { ...process.env, NODE_PATH: "" },
      });
      const res = runCheck(vdir);
      expect(res.status, "rebuilt tree reproduces").to.equal(0);
      expect(res.stdout).to.match(/ALL MATCH/);
    });
  });

  // ============================================================================================
  // (5) `--check` opens NO network and writes NOTHING under the source tree.
  // ============================================================================================
  describe("(5) `--check` opens NO network and writes NOTHING under the source tree", function () {
    // The SAME poison-guard the EPIC-31 isolation suite uses: trap every outbound network primitive so any
    // attempt to open a connection / DNS lookup / http(s) request throws synchronously. A clean `--check` run
    // PROVES the reproduce path opened no network handle.
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

    it("`--check` runs to a clean exit 0 with the network POISONED (no socket opened)", function () {
      const gdir = mkTmp();
      const guard = writeNetworkGuard(gdir);
      const res = spawnSync(process.execPath, ["--require", guard, BUILDER_PATH, "--check"], {
        encoding: "utf8",
        env: { ...process.env, NODE_PATH: "" },
      });
      const combined = (res.stdout || "") + (res.stderr || "");
      expect(combined, "guard never tripped").to.not.match(/NETWORK ACCESS ATTEMPTED/);
      expect(res.status, `exit 0 under poison guard (out: ${combined})`).to.equal(0);
      expect(res.stdout).to.match(/ALL MATCH/);
    });

    it("`--check` writes NOTHING under the source tree (the verifier/ tree is byte-identical before and after)", function () {
      // Snapshot the COPIED tree, run `--check` (which MUST be read-only), and assert every file is unchanged
      // and no file was added/removed.
      const vdir = copyVerifierTree();
      const before = hashTree(vdir);
      const res = runCheck(vdir);
      expect(res.status, "clean copy reproduces").to.equal(0);
      const after = hashTree(vdir);
      expect(after, "no file added/removed/modified by --check").to.deep.equal(before);
    });
  });

  // ============================================================================================
  // (6) THE EMBEDDED, SELF-ATTESTING PROVENANCE (T-54.2 rework) — the leverage that puts the provenance
  //     IN the single shipped file, so a counterparty handed JUST the bundle (no repo, no network, no
  //     sidecar) can:
  //       * `--provenance`  -> print the ordered source modules + hashes the bundle was built from, and
  //       * `--self-attest` -> confirm the file's OWN bytes are intact (MATCH/exit 0; one flipped byte ->
  //                            MISMATCH/exit 1). This is the trust feature that TRAVELS with the funnel
  //                            artifact, not an internal CI-only check.
  //     Each bundle is run STANDALONE (copied alone into an empty dir, NODE_PATH cleared) so we prove the
  //     feature needs nothing but the single file + Node core.
  // ============================================================================================
  describe("(6) embedded self-attesting provenance: `--self-attest` / `--provenance` on the single file", function () {
    // Copy ONE committed bundle alone into an empty temp dir and run it with the given args, NODE_PATH cleared,
    // so we exercise the bundle EXACTLY as a counterparty who was handed only that file would.
    function runBundleAlone(committedBundlePath, args) {
      const dir = mkTmp();
      const base = path.basename(committedBundlePath);
      const bundle = path.join(dir, base);
      fs.copyFileSync(committedBundlePath, bundle);
      // The bundle is alone in the dir — no package.json, no node_modules.
      expect(fs.readdirSync(dir).sort()).to.deep.equal([base]);
      const res = spawnSync(process.execPath, [bundle, ...(args || [])], {
        encoding: "utf8",
        cwd: dir,
        env: { ...process.env, NODE_PATH: "" },
      });
      return { res, bundle, dir };
    }

    for (const [label, committed] of [
      ["verify", ARTIFACTS.verifyBundle],
      ["seal", ARTIFACTS.sealBundle],
    ]) {
      it(`${label}: \`--self-attest\` on the clean committed bundle prints MATCH and exits 0 (from a single file)`, function () {
        const { res } = runBundleAlone(committed, ["--self-attest"]);
        expect(res.error, "no spawn error").to.equal(undefined);
        expect(res.status, `clean self-attest -> exit 0 (out: ${res.stdout}${res.stderr})`).to.equal(0);
        // The MATCH line names the recomputed selfSha256.
        expect(res.stdout).to.match(/\[MATCH\] self-attest: this file is intact \(selfSha256 [0-9a-f]{64}\)\./);
      });

      it(`${label}: flipping ONE byte of the bundle makes \`--self-attest\` print MISMATCH and exit 1`, function () {
        const { res: clean } = runBundleAlone(committed, ["--self-attest"]);
        expect(clean.status).to.equal(0);

        // Change ONE byte in a COPY, in a region that stays PARSEABLE (a character inside the embedded
        // provenance `note` string, away from the selfSha256 field), so `--self-attest` runs and detects the
        // file's OWN tampering with no external reference. (A flip in executable code would also exit non-zero,
        // but as a parse error before the handler runs — here we prove the handler itself catches the change.)
        const dir = mkTmp();
        const base = path.basename(committed);
        const bundle = path.join(dir, base);
        let s = fs.readFileSync(committed, "utf8");
        expect(s, "embedded note is present to tamper").to.include("self-describing");
        s = s.replace("self-describing", "self-Describing"); // ONE byte, inside a JSON string -> still parses
        fs.writeFileSync(bundle, s);
        const res = spawnSync(process.execPath, [bundle, "--self-attest"], {
          encoding: "utf8",
          cwd: dir,
          env: { ...process.env, NODE_PATH: "" },
        });
        expect(res.status, `tampered self-attest -> exit 1 (out: ${res.stdout}${res.stderr})`).to.equal(1);
        expect(res.stderr).to.match(/\[MISMATCH\] self-attest: this file has been MODIFIED/);
      });

      it(`${label}: editing the embedded selfSha256 hash itself is STILL a MISMATCH (no self-consistent forgery)`, function () {
        // An attacker who edits the body and then rewrites the embedded selfSha256 to "match" cannot win: the
        // self-hash is computed over the SENTINEL-blanked text, so changing the stored hash just makes the
        // stored value disagree with the recomputed one. Flip one hex digit of the stored selfSha256.
        const dir = mkTmp();
        const base = path.basename(committed);
        const bundle = path.join(dir, base);
        let s = fs.readFileSync(committed, "utf8");
        s = s.replace(/("selfSha256": "[0-9a-f])([0-9a-f])/, (m, a, b) => a + (b === "a" ? "b" : "a"));
        fs.writeFileSync(bundle, s);
        const res = spawnSync(process.execPath, [bundle, "--self-attest"], {
          encoding: "utf8",
          cwd: dir,
          env: { ...process.env, NODE_PATH: "" },
        });
        expect(res.status, "forged selfSha256 -> exit 1").to.equal(1);
        expect(res.stderr).to.match(/\[MISMATCH\] self-attest: this file has been MODIFIED/);
      });

      it(`${label}: \`--provenance\` prints the embedded manifest that EQUALS the committed BUILD-PROVENANCE.json's target`, function () {
        const { res } = runBundleAlone(committed, ["--provenance"]);
        expect(res.status, `--provenance -> exit 0 (out: ${res.stderr})`).to.equal(0);
        const printed = JSON.parse(res.stdout);
        expect(printed.schema).to.equal(builder.PROVENANCE_SCHEMA);
        expect(printed.target).to.equal(label);
        expect(printed.selfSha256, "selfSha256 is a 64-hex").to.match(/^[0-9a-f]{64}$/);
        // The embedded ordered modules are EXACTLY the committed manifest's modules for this target — so the
        // bundle's self-description can never drift from the committed source-of-truth manifest.
        const manifest = JSON.parse(fs.readFileSync(ARTIFACTS.provenance, "utf8"));
        expect(printed.modules).to.deep.equal(manifest.targets[label].modules);
      });
    }

    it("the in-process checkTarget() now also attests the embedded provenance (embedded.ok on the clean tree)", function () {
      for (const t of [builder.TARGETS.verify, builder.TARGETS.seal]) {
        const r = builder.checkTarget(t);
        expect(r.embedded.ok, `${t.name} embedded provenance reproduces`).to.equal(true);
        expect(r.ok, `${t.name} fully reproduces (incl. embedded)`).to.equal(true);
      }
    });

    it("`--check` FLAGS a tampered embedded selfSha256 in a committed bundle (exit 1, embedded MISMATCH)", function () {
      // Edit ONLY the embedded selfSha256 in a copied committed bundle (leaving the rest of the bytes alone):
      // `--check` must catch the divergence between the shipped embedded copy and what the build expects.
      const vdir = copyVerifierTree();
      const bundle = path.join(vdir, "dist", "verify-vh-standalone.js");
      let s = fs.readFileSync(bundle, "utf8");
      s = s.replace(/("selfSha256": "[0-9a-f])([0-9a-f])/, (m, a, b) => a + (b === "a" ? "b" : "a"));
      fs.writeFileSync(bundle, s);
      const res = runCheck(vdir);
      expect(res.status, "tampered embedded provenance -> exit 1").to.equal(1);
      const all = res.stdout + res.stderr;
      expect(all).to.match(/\[MISMATCH\] embedded dist\/verify-vh-standalone\.js:/);
    });

    it("`--self-attest` opens NO network (single-file trust check needs no connection)", function () {
      // Run the committed bundle's self-attest under the SAME poison guard the rest of this suite uses.
      const gdir = mkTmp();
      const guard = path.join(gdir, "net-guard.cjs");
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
          "",
        ].join("\n")
      );
      const res = spawnSync(process.execPath, ["--require", guard, ARTIFACTS.verifyBundle, "--self-attest"], {
        encoding: "utf8",
        env: { ...process.env, NODE_PATH: "" },
      });
      const combined = (res.stdout || "") + (res.stderr || "");
      expect(combined, "guard never tripped").to.not.match(/NETWORK ACCESS ATTEMPTED/);
      expect(res.status, `self-attest exit 0 under poison guard (out: ${combined})`).to.equal(0);
      expect(res.stdout).to.match(/\[MATCH\] self-attest/);
    });
  });
});

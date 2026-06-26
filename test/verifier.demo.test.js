"use strict";

// test/verifier.demo.test.js — T-55.2: the zero-config `demo` quickstart.
//
// WHY THIS TEST EXISTS
//   `verify-vh demo` is the product-led on-ramp: a brand-new user runs ONE command — no flags, no `--vendor`
//   to paste, no key knowledge, no install state — and watches the tool ACCEPT a genuine signed packet (naming
//   the signer), then REJECT a one-byte-tampered copy. The whole "don't trust us, verify it yourself" promise
//   is unfalsifiable until that first run works; this suite makes it TRUE in code so the prose can't drift.
//
//   The task acceptance, proven here:
//   (1) `node verifier/verify-vh.js demo` exits 0; stdout contains the ACCEPT verdict, the signer address, and
//       a REJECT line for the tampered copy.
//   (2) The STANDALONE bundle exposes the SAME demo — byte-identical stdout + same exit code as the in-tree
//       verifier (so a counterparty handed only the one file gets the identical quickstart).
//   (3) The rebuilt bundle still byte-matches its committed `.sha256` (T-54's reproduce chain stays intact),
//       AND `--check` still passes — the demo addition did not rot the deterministic build/provenance chain.
//
//   The demo signs with a FIXED, well-known TEST-ONLY key (hardhat account #1) — NEVER a real key / real
//   funds. The demo writes only into a throwaway temp dir it deletes; this suite asserts cwd is untouched.

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

// The in-tree verifier (the ORACLE the standalone must match) and the bundler (for the reproduce assertions).
const verifyvh = require("../verifier/verify-vh");
const builder = require("../verifier/build-standalone");
// The independent recovery the verifier itself uses — so the demo fixture's signer is RE-derived here, not
// merely echoed, proving the embedded signature genuinely recovers to the advertised address.
const { recoverPersonalSignAddress } = require("../verifier/lib/secp256k1-recover");

const INTREE_PATH = path.resolve(__dirname, "..", "verifier", "verify-vh.js");
const STANDALONE_PATH = path.resolve(__dirname, "..", "verifier", "dist", "verify-vh-standalone.js");
const SHA256_PATH = STANDALONE_PATH + ".sha256";

// The TEST-ONLY signer the demo packet is signed by (hardhat account #1 — never a real key / real funds).
const DEMO_SIGNER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

describe("verifier demo: zero-config `verify-vh demo` quickstart (T-55.2)", function () {
  // Child spawns + the demo's own temp-dir work can be a touch slower than a unit test; give headroom.
  this.timeout(60000);

  let cwdBefore;
  beforeEach(function () {
    cwdBefore = fs.readdirSync(process.cwd()).sort();
  });
  afterEach(function () {
    // FILESYSTEM HYGIENE: the demo writes ONLY into its own throwaway temp dir; nothing leaks into cwd.
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });

  // Capture the in-tree verifier's stdout/stderr from an in-process run. Returns { code, out, err }.
  function runInTree(args) {
    let out = "";
    let err = "";
    const code = verifyvh.run(args, { write: (s) => (out += s), writeErr: (s) => (err += s) });
    return { code, out, err };
  }

  // Run a bundle/script in a CHILD process. NODE_PATH is cleared so it cannot reach this repo's node_modules.
  function runChild(scriptPath, args, opts = {}) {
    return spawnSync(process.execPath, [scriptPath, ...args], {
      encoding: "utf8",
      cwd: opts.cwd || path.dirname(scriptPath),
      env: { ...process.env, NODE_PATH: "" },
      ...opts.spawn,
    });
  }

  // ============================================================================================
  // (1) `node verifier/verify-vh.js demo` — exit 0; ACCEPT + signer + a REJECT for the tampered copy.
  // ============================================================================================
  describe("(1) the in-tree `demo` produces the ACCEPT/signer/REJECT verdict and exits 0", function () {
    it("exits 0 and prints ACCEPT, the signer address, and a REJECT (CHANGED) line — in-process", function () {
      const { code, out } = runInTree(["demo"]);
      expect(code, "demo exits 0").to.equal(0);
      // The genuine packet is ACCEPTED and its signer named.
      expect(out, "names the ACCEPT verdict").to.match(/ACCEPT — the artifact verifies\./);
      expect(out, "names the recovered signer address").to.include(DEMO_SIGNER);
      // The one-byte-tampered copy is REJECTED, naming the changed file.
      expect(out, "names a REJECT verdict").to.match(/REJECT \(CHANGED\)/);
      expect(out, "names the tampered file").to.match(/CHANGED\s+model-card\.md/);
      // The honest scope note is surfaced (tamper-evidence, NOT a trusted timestamp).
      expect(out).to.match(/TAMPER-EVIDENCE/);
    });

    it("exits 0 as a real CHILD PROCESS too (`node verify-vh.js demo`, no flags, no key)", function () {
      const res = runChild(INTREE_PATH, ["demo"]);
      expect(res.error, "no spawn error").to.equal(undefined);
      expect(res.status, `exit 0 (stderr: ${res.stderr})`).to.equal(0);
      expect(res.stdout).to.match(/ACCEPT — the artifact verifies\./);
      expect(res.stdout).to.include(DEMO_SIGNER);
      expect(res.stdout).to.match(/REJECT \(CHANGED\)/);
    });

    it("the demo's embedded signature genuinely RECOVERS to the advertised signer (not echoed)", function () {
      // Independently recover the signer from the embedded container's bytes with the verifier's OWN routine —
      // so the address the demo prints is proven to come from the signature, not from the `signer` field.
      const c = verifyvh.DEMO_CONTAINER;
      const recovered = recoverPersonalSignAddress(c.attestation, c.signature.signature);
      expect(recovered).to.equal(DEMO_SIGNER);
      expect(c.signature.signer).to.equal(DEMO_SIGNER);
    });

    it("`demo` writes NOTHING under cwd (its temp dir is throwaway and cleaned up)", function () {
      const before = fs.readdirSync(process.cwd()).sort();
      const res = runChild(INTREE_PATH, ["demo"], { cwd: process.cwd() });
      expect(res.status).to.equal(0);
      expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(before);
    });
  });

  // ============================================================================================
  // (2) The STANDALONE bundle exposes the SAME demo.
  // ============================================================================================
  describe("(2) the standalone bundle exposes the SAME demo (byte-identical stdout + exit code)", function () {
    it("`node verify-vh-standalone.js demo` matches the in-tree verifier stdout + exit code", function () {
      const oracle = runInTree(["demo"]);
      const sa = runChild(STANDALONE_PATH, ["demo"]);
      expect(sa.error, "no spawn error").to.equal(undefined);
      expect(sa.status, `exit code matches (in-tree ${oracle.code}, stderr: ${sa.stderr})`).to.equal(oracle.code);
      // The standalone's stdout must equal the in-tree's stdout byte-for-byte EXCEPT the throwaway temp-dir
      // path line (which is randomized per run); normalize that single line away before comparing.
      const norm = (s) => s.replace(/^# Working dir .*$/m, "# Working dir <tmp>");
      expect(norm(sa.stdout), "stdout matches the in-tree verifier (mod the temp-dir line)").to.equal(
        norm(oracle.out)
      );
    });

    it("the standalone `demo` runs from an EMPTY dir with no node_modules (exit 0)", function () {
      const os = require("os");
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "vh-demo-empty-"));
      try {
        const bundle = path.join(empty, "verify-vh-standalone.js");
        fs.copyFileSync(STANDALONE_PATH, bundle);
        expect(fs.readdirSync(empty).sort()).to.deep.equal(["verify-vh-standalone.js"]);
        const res = runChild(bundle, ["demo"], { cwd: empty });
        expect(res.status, `exit 0 (stderr: ${res.stderr})`).to.equal(0);
        expect(res.stdout).to.match(/ACCEPT — the artifact verifies\./);
        expect(res.stdout).to.match(/REJECT \(CHANGED\)/);
        // READ-ONLY: the empty dir still holds only the bundle (the demo's temp dir lives in os.tmpdir()).
        expect(fs.readdirSync(empty).sort()).to.deep.equal(["verify-vh-standalone.js"]);
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    });
  });

  // ============================================================================================
  // (3) The rebuilt bundle still byte-matches its committed `.sha256` — T-54 reproduce chain intact.
  // ============================================================================================
  describe("(3) the demo addition keeps the committed bundle + reproduce chain byte-exact", function () {
    function sha256Hex(buf) {
      return crypto.createHash("sha256").update(buf).digest("hex");
    }

    it("the committed standalone bundle matches a fresh rebuild byte-for-byte (it carries the demo)", function () {
      const fresh = builder.buildBundle();
      const committed = fs.readFileSync(STANDALONE_PATH, "utf8");
      expect(
        committed,
        "verify-vh-standalone.js is STALE — re-run `node verifier/build-standalone.js` and commit it"
      ).to.equal(fresh);
      // And the bundle genuinely embeds the demo (so the standalone really is the SAME quickstart).
      expect(committed, "the bundle inlines the demo signer fixture").to.include(DEMO_SIGNER);
    });

    it("the committed `.sha256` sidecar equals the SHA-256 of the committed bundle (no rot)", function () {
      const bundle = fs.readFileSync(STANDALONE_PATH); // raw bytes — hash exactly as shipped
      const sidecar = fs.readFileSync(SHA256_PATH, "utf8");
      const publishedHex = sidecar.trim().split(/\s+/)[0].toLowerCase();
      expect(
        publishedHex,
        "verify-vh-standalone.js.sha256 is STALE — re-run `node verifier/build-standalone.js` and commit it"
      ).to.equal(sha256Hex(bundle));
      // The sidecar is also byte-identical to the build's own deterministic sidecar of the committed text.
      expect(sidecar).to.equal(builder.sha256Sidecar(fs.readFileSync(STANDALONE_PATH, "utf8")));
    });

    it("`--check` still reports ALL MATCH (the reproduce/provenance chain is intact)", function () {
      // Run the read-only reproduce-and-attest mode in-process via the builder's runCheck with captured IO.
      let out = "";
      let err = "";
      const code = builder.runCheck({ write: (s) => (out += s), writeErr: (s) => (err += s) });
      expect(code, `--check exit 0 (stderr: ${err})`).to.equal(0);
      expect(out).to.match(/ALL MATCH/);
      expect(out, "no MISMATCH line").to.not.match(/MISMATCH/);
    });
  });

  // ============================================================================================
  // (4) `demo <dir>` — the KEEPABLE scaffold (T-55.2 rework). The bare demo is a closed loop in a temp dir
  //     the prospect can WATCH but never TOUCH; `demo <dir>` writes the SAME genuine packet into a dir they
  //     KEEP and prints copy-paste verify/tamper/restore commands. This is the funnel on-ramp: the new user's
  //     first hands-on artifact is a real packet on disk they verify with the REAL (non-canned) verify path.
  //     We prove the scaffold is genuine — not a separate verify path — by feeding what it WROTE back through
  //     the public `verifyArtifact` and asserting ACCEPT/REJECT exactly as a counterparty would see.
  // ============================================================================================
  describe("(4) `demo <dir>` writes a real, keepable, genuinely-verifying packet", function () {
    const os = require("os");
    let work;
    beforeEach(function () {
      // A throwaway dir OUTSIDE cwd (so the cwd-hygiene afterEach still holds); the scaffold writes here.
      work = fs.mkdtempSync(path.join(os.tmpdir(), "vh-demo-emit-"));
    });
    afterEach(function () {
      fs.rmSync(work, { recursive: true, force: true });
    });

    it("exits 0, creates the dir, and writes the packet + both referenced files", function () {
      const target = path.join(work, "kept"); // does NOT exist yet — the scaffold must mkdir -p it
      const { code, out } = runInTree(["demo", target]);
      expect(code, "demo <dir> exits 0").to.equal(0);
      expect(fs.existsSync(target), "the named dir was created").to.equal(true);
      const got = fs.readdirSync(target).sort();
      expect(got).to.deep.equal(
        [verifyvh.DEMO_PACKET_NAME, ...Object.keys(verifyvh.DEMO_FILES)].sort()
      );
      // It tells the user it wrote a keepable packet and names the recovered signer (not echoed — see below).
      expect(out, "names what it wrote").to.include(verifyvh.DEMO_PACKET_NAME);
      expect(out, "names the recovered signer").to.include(DEMO_SIGNER);
      // It pulls toward the PAID producer side (the free→paid funnel the rework exists to widen).
      expect(out, "pulls toward the paid signing upgrade").to.match(/vh evidence seal .*--sign/);
    });

    it("what it WROTE verifies through the REAL public core — ACCEPT, signer pinned", function () {
      const target = path.join(work, "kept");
      runInTree(["demo", target]);
      const packet = path.join(target, verifyvh.DEMO_PACKET_NAME);
      // Re-derive the signer from the packet's OWN bytes (independent of any printed line), then verify with it.
      const container = JSON.parse(fs.readFileSync(packet, "utf8"));
      const signer = recoverPersonalSignAddress(container.attestation, container.signature.signature);
      expect(signer, "the written packet recovers to the demo signer").to.equal(DEMO_SIGNER);
      const good = verifyvh.verifyArtifact({ artifact: packet, vendor: signer, dir: target });
      expect(good.code, "the written packet ACCEPTS").to.equal(verifyvh.EXIT.OK);
      expect(good.result.accepted).to.equal(true);
      expect(good.result.recoveredSigner).to.equal(DEMO_SIGNER);
    });

    it("the printed tamper step is HONEST: a one-byte change makes the SAME packet REJECT (CHANGED)", function () {
      const target = path.join(work, "kept");
      runInTree(["demo", target]);
      const packet = path.join(target, verifyvh.DEMO_PACKET_NAME);
      const card = path.join(target, "model-card.md");
      // Reproduce the exact `printf 'X' >> model-card.md` the scaffold instructs, then re-verify.
      fs.appendFileSync(card, "X");
      const bad = verifyvh.verifyArtifact({ artifact: packet, vendor: DEMO_SIGNER, dir: target });
      expect(bad.code, "the tampered packet REJECTS").to.equal(verifyvh.EXIT.REJECTED);
      expect(bad.result.reason).to.equal("CHANGED");
      expect(bad.result.changed.map((c) => c.relPath)).to.include("model-card.md");
      // Restore the byte and it ACCEPTS again — proving the change was the ONLY reason it rejected.
      fs.writeFileSync(card, verifyvh.DEMO_FILES["model-card.md"]);
      const restored = verifyvh.verifyArtifact({ artifact: packet, vendor: DEMO_SIGNER, dir: target });
      expect(restored.code, "restored packet ACCEPTS").to.equal(verifyvh.EXIT.OK);
    });

    it("the written packet is byte-identical to the in-file fixture (no second source of truth)", function () {
      const target = path.join(work, "kept");
      runInTree(["demo", target]);
      const written = JSON.parse(fs.readFileSync(path.join(target, verifyvh.DEMO_PACKET_NAME), "utf8"));
      expect(written, "scaffold packet == the fixture the bare demo runs").to.deep.equal(
        verifyvh.DEMO_CONTAINER
      );
    });

    it("a SECOND positional or any flag falls through to the normal path (no silent flag-eating)", function () {
      // `demo <dir> <extra>` is NOT the scaffold contract; it must hit the normal verify path, where a file
      // literally named `demo` is a clean error — never a scaffold run that ignored the extra token.
      const { code: tooMany } = runInTree(["demo", path.join(work, "x"), "extra"]);
      expect(tooMany, "demo + dir + extra is not a scaffold (batch/IO/usage, never 0)").to.not.equal(0);
      expect(fs.existsSync(path.join(work, "x")), "no scaffold was written for the 3-arg form").to.equal(false);
      // `demo <dir> --json` likewise is not the (flagless) scaffold contract.
      const { code: withFlag } = runInTree(["demo", path.join(work, "y"), "--json"]);
      expect(withFlag, "demo + dir + flag is not a scaffold").to.not.equal(0);
      expect(fs.existsSync(path.join(work, "y")), "no scaffold for the flagged form").to.equal(false);
    });

    it("the STANDALONE bundle exposes the SAME `demo <dir>` scaffold (exit 0, same files, ACCEPTs)", function () {
      const target = path.join(work, "sa-kept");
      const res = runChild(STANDALONE_PATH, ["demo", target]);
      expect(res.error, "no spawn error").to.equal(undefined);
      expect(res.status, `standalone demo <dir> exit 0 (stderr: ${res.stderr})`).to.equal(0);
      expect(fs.readdirSync(target).sort()).to.deep.equal(
        [verifyvh.DEMO_PACKET_NAME, ...Object.keys(verifyvh.DEMO_FILES)].sort()
      );
      // The packet the STANDALONE wrote verifies through the in-tree core too (same artifact, same verdict).
      const packet = path.join(target, verifyvh.DEMO_PACKET_NAME);
      const good = verifyvh.verifyArtifact({ artifact: packet, vendor: DEMO_SIGNER, dir: target });
      expect(good.code, "standalone-written packet ACCEPTS via the in-tree core").to.equal(verifyvh.EXIT.OK);
    });
  });
});

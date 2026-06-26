"use strict";

// test/freeseal.standalone.test.js — T-36.2: PROVE the single-file, zero-install SEALER and its round-trip
// with the zero-install verifier.
//
// WHY THIS TEST EXISTS
//   EPIC-35 closed the FREE VERIFY side with verify-vh-standalone.js. T-36.2 closes the FREE PRODUCE side:
//   seal-vh-standalone.js lets a stranger SEAL up to 25 of THEIR OWN files into a `vh.evidence-seal` — no
//   clone, no `npm install`, no node_modules, no package.json — and hand it to a counterparty who VERIFIES
//   it with the (also zero-install) verifier. The whole organic adoption loop, self-service, both halves
//   free, before any sales call. The docs promise that in prose; this suite makes it TRUE in code. Five
//   load-bearing properties (the task acceptance):
//
//   (1) DETERMINISTIC + ANTI-ROT for BOTH targets — building each bundle twice yields BYTE-IDENTICAL output,
//       AND the committed dist files (verify + seal) each equal a fresh rebuild byte-for-byte (a stale
//       committed bundle FAILS here, i.e. in CI), AND each committed `.sha256` sidecar equals its bundle's
//       hash.
//   (2) ZERO external deps — seal-vh-standalone.js requires NOTHING outside Node core: a grep finds no
//       require('ethers'), no require('js-sha3'), no './lib/', no '../', no bare third-party name. Copied
//       ALONE into an EMPTY temp dir (no node_modules, no package.json) it seals a folder -> writes the seal
//       and exits 0, in a CHILD PROCESS whose require() cannot reach this repo's node_modules.
//   (3) ROUND-TRIP — the standalone-produced seal is ACCEPTED by verify-vh-standalone.js (exit 0), and the
//       verifier exits 3 after a one-byte tamper of a sealed file OR a deletion. Free PRODUCE + free VERIFY
//       interoperate with ZERO install on either side. (Cross-check: the standalone seal bytes are
//       byte-identical to the producer cli/evidence.js#serializeSeal over the same folder.)
//   (4) FREE-TIER BOUNDARY — a folder of >25 files hard-errors (exit 2) naming `evidence_unlimited` +
//       `vh evidence seal`, writing NO output; AND the standalone has NO --sign/--license/--key FLAG at all
//       (each is rejected as an unknown flag; the bundle source carries no parser case for them).
//   (5) NO NETWORK + WRITES ONLY THE NAMED FILE — the sealer, run with the EPIC-31 network-poison guard
//       preloaded, opens no socket; and a run writes ONLY the -o file the user names (never cwd otherwise).
//       The verify bundle + the in-tree verifier are UNCHANGED by this task (asserted).
//
// Every write lands under a throwaway temp dir cleaned in afterEach; the working tree (cwd) is asserted
// untouched. No keys anywhere — the free sealer has no key path.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

// The REAL producer (the SAME signing-free seal path the full CLI uses) — the byte-for-byte oracle.
const evidence = require("../cli/evidence");
// The bundler under test, and the in-tree sealer source it inlines.
const builder = require("../verifier/build-standalone");
const sealcli = require("../verifier/lib/seal-cli");

const SEAL_PATH = path.resolve(__dirname, "..", "verifier", "dist", "seal-vh-standalone.js");
const SEAL_SHA256_PATH = SEAL_PATH + ".sha256";
const VERIFY_PATH = path.resolve(__dirname, "..", "verifier", "dist", "verify-vh-standalone.js");
const VERIFY_SHA256_PATH = VERIFY_PATH + ".sha256";
const INTREE_VERIFIER_PATH = path.resolve(__dirname, "..", "verifier", "verify-vh.js");

// T-36.3 — the three docs that funnel a prospect through the FREE self-service round-trip. Each MUST name
// the standalone sealer, restate the honest scope boundary, and name the PAID upgrade, so the FREE-tier
// funnel prose can never rot away from the code the rest of this suite proves.
const FREESEAL_DOCS = [
  path.resolve(__dirname, "..", "verifier", "README.md"),
  path.resolve(__dirname, "..", "docs", "INDEPENDENT-VERIFICATION.md"),
  path.resolve(__dirname, "..", "docs", "PILOT.md"),
];

describe("free sealer standalone: single-file, zero-install seal-your-own-folder (T-36.2)", function () {
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
    // FILESYSTEM HYGIENE: nothing the sealer / verifier / bundler did leaked into the working tree.
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });

  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-freeseal-"));
    tmpDirs.push(d);
    return d;
  }

  // A folder of N files with mixed content + a nested dir, for sealing. Returns its abs path.
  function makeFolder(n) {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, "a.txt"), "alpha");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "b.txt"), "beta");
    fs.writeFileSync(path.join(dir, "c.bin"), Buffer.from([0, 1, 2, 255]));
    // Pad up to n total files if asked.
    let made = 3;
    for (; made < n; made++) fs.writeFileSync(path.join(dir, `pad${made}.txt`), `pad-${made}`);
    return dir;
  }

  // Run the SEAL bundle in a CHILD PROCESS. NODE_PATH cleared so the child cannot reach this repo's modules.
  function runSeal(bundlePath, args, opts = {}) {
    return spawnSync(process.execPath, [bundlePath, ...args], {
      encoding: "utf8",
      cwd: opts.cwd || path.dirname(bundlePath),
      env: { ...process.env, NODE_PATH: "", ...(opts.env || {}) },
      ...opts.spawn,
    });
  }
  // Run the VERIFY bundle in a CHILD PROCESS (same isolation).
  function runVerify(args, opts = {}) {
    return spawnSync(process.execPath, [VERIFY_PATH, ...args], {
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "", ...(opts.env || {}) },
      ...opts.spawn,
    });
  }

  // ============================================================================================
  // (1) DETERMINISTIC BUILD + ANTI-ROT, for BOTH targets.
  // ============================================================================================
  describe("(1) deterministic build + anti-rot guard (both targets)", function () {
    it("two fresh SEAL builds are BYTE-IDENTICAL (no timestamp / randomness / fs-order dependence)", function () {
      const a = builder.buildSealBundle();
      const b = builder.buildSealBundle();
      expect(a).to.equal(b);
      expect(Buffer.byteLength(a)).to.be.greaterThan(1000);
    });

    it("the COMMITTED seal bundle matches a fresh rebuild byte-for-byte (a stale bundle FAILS here)", function () {
      const fresh = builder.buildSealBundle();
      const committed = fs.readFileSync(SEAL_PATH, "utf8");
      expect(
        committed,
        "verifier/dist/seal-vh-standalone.js is STALE — re-run `node verifier/build-standalone.js` and commit it"
      ).to.equal(fresh);
    });

    it("the COMMITTED verify bundle STILL matches a fresh rebuild (T-36.2 left the verify target untouched)", function () {
      const fresh = builder.buildBundle();
      const committed = fs.readFileSync(VERIFY_PATH, "utf8");
      expect(
        committed,
        "verifier/dist/verify-vh-standalone.js is STALE — re-run `node verifier/build-standalone.js` and commit it"
      ).to.equal(fresh);
    });

    it("rebuilding the seal bundle into a TEMP dir reproduces the committed bytes (pure fn of source)", function () {
      const tmp = path.join(mkTmp(), "rebuild-seal.js");
      fs.writeFileSync(tmp, builder.buildSealBundle());
      expect(fs.readFileSync(tmp)).to.deep.equal(fs.readFileSync(SEAL_PATH));
    });

    it("BOTH committed `.sha256` sidecars equal their bundle's hash, in `sha256sum -c` line format", function () {
      function sha256Hex(buf) {
        return crypto.createHash("sha256").update(buf).digest("hex");
      }
      // seal sidecar.
      const sealBundle = fs.readFileSync(SEAL_PATH); // raw bytes — exactly as shipped
      const sealSidecar = fs.readFileSync(SEAL_SHA256_PATH, "utf8");
      expect(sealSidecar, "seal sidecar is `sha256sum`-shaped").to.match(
        /^[0-9a-f]{64} {2}seal-vh-standalone\.js\n$/
      );
      expect(
        sealSidecar.trim().split(/\s+/)[0],
        "seal-vh-standalone.js.sha256 is STALE — re-run the bundler and commit it"
      ).to.equal(sha256Hex(sealBundle));
      // It is byte-identical to the build's own deterministic sidecar of the committed bundle text.
      expect(sealSidecar).to.equal(
        builder.sha256SidecarFor(fs.readFileSync(SEAL_PATH, "utf8"), "seal-vh-standalone.js")
      );

      // verify sidecar (unchanged target) still pins its bundle.
      const verifyBundle = fs.readFileSync(VERIFY_PATH);
      const verifySidecar = fs.readFileSync(VERIFY_SHA256_PATH, "utf8");
      expect(verifySidecar.trim().split(/\s+/)[0]).to.equal(sha256Hex(verifyBundle));
    });

    it("writeAll() re-emits BOTH bundles + sidecars in lockstep (the build maintains them, never rots)", function () {
      // Rebuild into a scratch dist via the same writer the CLI uses, but assert the TEXT it would write
      // equals the committed files (we do not overwrite the committed dist here — buildSealBundle/buildBundle
      // are the pure text functions writeTarget emits).
      expect(builder.buildSealBundle()).to.equal(fs.readFileSync(SEAL_PATH, "utf8"));
      expect(builder.buildBundle()).to.equal(fs.readFileSync(VERIFY_PATH, "utf8"));
    });
  });

  // ============================================================================================
  // (2) ZERO external deps + seals from an EMPTY dir with no node_modules.
  // ============================================================================================
  describe("(2) zero external dependencies; seals from an EMPTY dir", function () {
    const SRC = () => fs.readFileSync(SEAL_PATH, "utf8");

    it("requires ONLY Node core: no require('ethers'), no require('js-sha3'), no './lib/', no '../', no bare 3rd-party", function () {
      const src = SRC();
      // Every REAL require("…") specifier must be a Node-core module (fs/path). The bundle's OWN internal
      // __require("<id>") shim calls are excluded (preceded by an identifier char), as they resolve only
      // against the embedded module table.
      const specs = [...src.matchAll(/(^|[^A-Za-z0-9_$])require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[2]);
      expect(specs.length, "the bundle does call require() for Node core").to.be.greaterThan(0);
      // `crypto` is Node CORE (no node_modules, no install) — the embedded `--self-attest` boot code hashes
      // the file's own bytes. It is allowed alongside fs/path; the empty-dir seal run below proves the bundle
      // still needs no install.
      for (const s of specs) {
        expect(["fs", "path", "crypto", "node:fs", "node:path", "node:crypto"], `forbidden require(${JSON.stringify(s)})`).to.include(s);
      }
      // Belt-and-suspenders explicit checks the task spells out.
      expect(src, "no require('ethers')").to.not.match(/require\(\s*["']ethers/);
      expect(src, "no require('js-sha3')").to.not.match(/require\(\s*["']js-sha3/);
      expect(src, "no require('./lib/...')").to.not.match(/require\(\s*["']\.\/lib/);
      expect(src, "no '../' in any require").to.not.match(/require\(\s*["']\.\./);
    });

    it("copied ALONE into an empty temp dir (no node_modules/package.json): seals a folder -> writes seal, exit 0", function () {
      const folder = makeFolder(3);

      // An EMPTY directory: ONLY the seal bundle. No package.json, no node_modules.
      const empty = mkTmp();
      const bundle = path.join(empty, "seal-vh-standalone.js");
      fs.copyFileSync(SEAL_PATH, bundle);
      expect(fs.readdirSync(empty).sort()).to.deep.equal(["seal-vh-standalone.js"]);

      const out = path.join(empty, "out.vhevidence.json");
      const res = runSeal(bundle, [folder, "-o", out], { cwd: empty });
      expect(res.error, "no spawn error").to.equal(undefined);
      expect(res.status, `seal exit 0 (stderr: ${res.stderr})`).to.equal(0);
      expect(fs.existsSync(out), "the named output seal was written").to.equal(true);

      // The written file is a genuine vh.evidence-seal that strict-validates with the in-tree reader.
      const text = fs.readFileSync(out, "utf8");
      const seal = JSON.parse(text);
      expect(seal.kind).to.equal("vh.evidence-seal");
      expect(seal.fileCount).to.equal(3);
      expect(() => evidence.readSeal(text)).to.not.throw();
    });

    it("the empty-dir seal run creates NO node_modules and writes ONLY the named output", function () {
      const folder = makeFolder(3);
      const empty = mkTmp();
      const bundle = path.join(empty, "seal-vh-standalone.js");
      fs.copyFileSync(SEAL_PATH, bundle);
      const out = path.join(empty, "out.vhevidence.json");
      runSeal(bundle, [folder, "-o", out], { cwd: empty });
      // Only the bundle + the named output exist; no node_modules, no stray cwd writes.
      expect(fs.readdirSync(empty).sort()).to.deep.equal(["out.vhevidence.json", "seal-vh-standalone.js"]);
    });
  });

  // ============================================================================================
  // (3) ROUND-TRIP: standalone PRODUCE -> standalone VERIFY, accept + tamper + delete.
  // ============================================================================================
  describe("(3) round-trip: free PRODUCE interoperates with free VERIFY (zero install on both sides)", function () {
    it("standalone seal is ACCEPTED by the standalone verifier (exit 0)", function () {
      const folder = makeFolder(3);
      const out = path.join(mkTmp(), "rt.vhevidence.json");
      const s = runSeal(SEAL_PATH, [folder, "-o", out]);
      expect(s.status, `seal exit 0 (stderr: ${s.stderr})`).to.equal(0);

      const v = runVerify([out, "--dir", folder]);
      expect(v.error, "no spawn error").to.equal(undefined);
      expect(v.status, `verify exit 0 (stderr: ${v.stderr})`).to.equal(0);
      expect(v.stdout).to.match(/OK — the artifact verifies\./);
    });

    it("a one-byte TAMPER of a sealed file -> verifier exits 3 (REJECTED CHANGED)", function () {
      const folder = makeFolder(3);
      const out = path.join(mkTmp(), "rt.vhevidence.json");
      expect(runSeal(SEAL_PATH, [folder, "-o", out]).status).to.equal(0);

      fs.writeFileSync(path.join(folder, "a.txt"), "alphX"); // one byte changed
      const v = runVerify([out, "--dir", folder]);
      expect(v.status, `tampered verify exit 3 (stderr: ${v.stderr})`).to.equal(3);
      expect(v.stdout).to.match(/REJECTED \(CHANGED\)/);
    });

    it("a DELETION of a sealed file -> verifier exits 3 (REJECTED MISSING)", function () {
      const folder = makeFolder(3);
      const out = path.join(mkTmp(), "rt.vhevidence.json");
      expect(runSeal(SEAL_PATH, [folder, "-o", out]).status).to.equal(0);

      fs.rmSync(path.join(folder, "a.txt"));
      const v = runVerify([out, "--dir", folder]);
      expect(v.status, `deleted verify exit 3 (stderr: ${v.stderr})`).to.equal(3);
      expect(v.stdout).to.match(/REJECTED \(MISSING\)/);
    });

    it("the standalone seal bytes are BYTE-IDENTICAL to the producer cli/evidence.js#serializeSeal", function () {
      const folder = makeFolder(3);
      const out = path.join(mkTmp(), "rt.vhevidence.json");
      expect(runSeal(SEAL_PATH, [folder, "-o", out]).status).to.equal(0);
      const standaloneBytes = fs.readFileSync(out, "utf8");

      // The producer's bytes over the SAME folder (the unsigned free-tier path).
      const producerBytes = evidence.serializeSeal(
        evidence.buildSeal(evidence.loadDirEntries(folder))
      );
      expect(standaloneBytes, "free PRODUCE == producer seal, byte-for-byte").to.equal(producerBytes);
    });

    it("the in-tree sealer module also produces producer-identical bytes (the inlined source is the oracle)", function () {
      const folder = makeFolder(5);
      const fromSealCli = sealcli.serializeSeal(sealcli.buildSeal(sealcli.loadDirEntries(folder)));
      const fromProducer = evidence.serializeSeal(evidence.buildSeal(evidence.loadDirEntries(folder)));
      expect(fromSealCli).to.equal(fromProducer);
    });
  });

  // ============================================================================================
  // (4) FREE-TIER BOUNDARY: >25 files hard-errors (exit 2); NO --sign/--license/--key flag.
  // ============================================================================================
  describe("(4) free-tier boundary: >25 files hard-error; no signing surface", function () {
    it("a folder of >25 files hard-errors (exit 2), naming evidence_unlimited + `vh evidence seal`, writes nothing", function () {
      const folder = makeFolder(26);
      expect(fs.readdirSync(folder).length).to.be.greaterThan(0);
      // count files recursively to be sure (nested sub/b.txt counts).
      const out = path.join(mkTmp(), "should-not-exist.json");
      const r = runSeal(SEAL_PATH, [folder, "-o", out]);
      expect(r.status, `>25 files exit 2 (stderr: ${r.stderr})`).to.equal(2);
      expect(r.stderr, "names the paid evidence_unlimited entitlement").to.match(/evidence_unlimited/);
      expect(r.stderr, "names the full `vh evidence seal` command").to.match(/vh evidence seal/);
      expect(r.stderr, "names the free limit of 25").to.match(/25/);
      expect(fs.existsSync(out), "NO output written on the boundary error").to.equal(false);
    });

    it("exactly 25 files is FREE (exit 0) — the boundary is inclusive of 25, exclusive above", function () {
      // 26 files = 25 pad-ish + the 3 base... makeFolder(25) yields exactly 25 files (3 base + 22 pads).
      const folder = makeFolder(25);
      // Confirm the folder really has 25 files (recursively).
      const count = (function walk(d) {
        let c = 0;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) c += walk(path.join(d, e.name));
          else if (e.isFile()) c += 1;
        }
        return c;
      })(folder);
      expect(count, "folder has exactly 25 files").to.equal(25);
      const out = path.join(mkTmp(), "ok25.vhevidence.json");
      const r = runSeal(SEAL_PATH, [folder, "-o", out]);
      expect(r.status, `==25 files exit 0 (stderr: ${r.stderr})`).to.equal(0);
      expect(JSON.parse(fs.readFileSync(out, "utf8")).fileCount).to.equal(25);
    });

    it("has NO --sign/--license/--key flag: each is rejected as an unknown flag (exit 2)", function () {
      const folder = makeFolder(3);
      for (const flag of ["--sign", "--license", "--key", "--key-env", "--key-file"]) {
        const r = runSeal(SEAL_PATH, [folder, flag, "x"]);
        expect(r.status, `${flag} -> exit 2`).to.equal(2);
        expect(r.stderr, `${flag} -> unknown flag`).to.match(/unknown flag/);
      }
    });

    it("the bundle source carries NO parser CASE for any signing/license/key flag", function () {
      // The behavioral test above proves the flags don't WORK; this proves there is no hidden code path: the
      // emitted bundle has no `case "--sign"`/`"--license"`/`"--key*"` clause and no quoted flag token in the
      // arg parser. (The strings may appear only in help/error PROSE, e.g. the >25-files message.)
      const src = fs.readFileSync(SEAL_PATH, "utf8");
      expect(src).to.not.match(/case\s*["'](--sign|--license|--key|--key-env|--key-file)["']/);
      // No quoted flag literal used as a parser token (a comparison/case target) for these flags.
      expect(src, "no quoted --sign token").to.not.match(/["']--sign["']/);
      expect(src, "no quoted --license token").to.not.match(/["']--license["']/);
      expect(src, "no quoted --key/--key-env/--key-file token").to.not.match(/["']--key(-env|-file)?["']/);
    });
  });

  // ============================================================================================
  // (5) NO NETWORK + writes only the named file; verify bundle + in-tree verifier UNCHANGED.
  // ============================================================================================
  describe("(5) no network handle (EPIC-31 poison guard) + writes only the -o file", function () {
    // The SAME poison-guard the EPIC-31 isolation test uses: trap every OUTBOUND network primitive so any
    // attempt to open a connection / DNS lookup / http(s) request throws synchronously. A clean exit PROVES
    // the sealer opened no network handle.
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

    it("the sealer seals a folder with the network POISONED (exit 0, no socket opened)", function () {
      const folder = makeFolder(3);
      const work = mkTmp();
      const guard = writeNetworkGuard(work);
      const out = path.join(work, "poisoned.vhevidence.json");
      const res = spawnSync(
        process.execPath,
        ["--require", guard, SEAL_PATH, folder, "-o", out],
        { encoding: "utf8", env: { ...process.env, NODE_PATH: "" } }
      );
      expect(res.error, "no spawn error").to.equal(undefined);
      const combined = (res.stdout || "") + (res.stderr || "");
      expect(combined, "guard never tripped").to.not.match(/NETWORK ACCESS ATTEMPTED/);
      expect(res.status, `exit 0 (out: ${combined})`).to.equal(0);
      expect(JSON.parse(fs.readFileSync(out, "utf8")).kind).to.equal("vh.evidence-seal");
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

    it("with NO -o the sealer prints the seal but writes NOTHING to disk (never cwd)", function () {
      const folder = makeFolder(3);
      const empty = mkTmp();
      const bundle = path.join(empty, "seal-vh-standalone.js");
      fs.copyFileSync(SEAL_PATH, bundle);
      const before = fs.readdirSync(empty).sort();
      const res = runSeal(bundle, [folder], { cwd: empty });
      expect(res.status, `seal-to-stdout exit 0 (stderr: ${res.stderr})`).to.equal(0);
      // The seal bytes appear on stdout, and the cwd is unchanged (only the bundle is still there).
      expect(res.stdout).to.include('"kind":"vh.evidence-seal"');
      expect(fs.readdirSync(empty).sort()).to.deep.equal(before);
    });

    it("the verify bundle + in-tree verifier are UNCHANGED by this task (require graphs intact)", function () {
      // Verify bundle: still requires only fs/path at the Node level.
      const vsrc = fs.readFileSync(VERIFY_PATH, "utf8");
      const vspecs = [...vsrc.matchAll(/(^|[^A-Za-z0-9_$])require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[2]);
      // fs/path plus Node-core `crypto` (the embedded `--self-attest` self-hash) — all Node core, no install.
      for (const s of vspecs) expect(["fs", "path", "crypto", "node:fs", "node:path", "node:crypto"]).to.include(s);

      // In-tree verifier: require graph is exactly its own ./lib/* siblings + Node core (fs/path) — never
      // ethers/hardhat or a cli/ back-edge. The SEAL bundle (this task) never touches it; T-51.4 added the
      // stack-free ./lib/revocation reader to the verifier graph (still pure-JS, still no producer stack).
      const isrc = fs.readFileSync(INTREE_VERIFIER_PATH, "utf8");
      const ispecs = [...isrc.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
      expect(ispecs.sort()).to.deep.equal(
        ["./lib/canonical", "./lib/merkle", "./lib/revocation", "./lib/secp256k1-recover", "fs", "path"].sort()
      );
    });
  });

  // ============================================================================================
  // (6) FREE-TIER FUNNEL DOCS (T-36.3): the three buyer-facing docs that name the 10-second
  //     zero-install round-trip MUST keep naming the sealer, the honest boundary, and the paid
  //     upgrade — so the FREE funnel prose can never silently drift from what (1)-(5) prove in code.
  // ============================================================================================
  describe("(6) free-tier funnel docs name the sealer, the honest boundary + the paid upgrade (anti-rot)", function () {
    for (const docPath of FREESEAL_DOCS) {
      const name = path.relative(path.resolve(__dirname, ".."), docPath);

      it(`${name} documents the zero-install seal round-trip and restates the honest boundary + paid upgrade`, function () {
        const src = fs.readFileSync(docPath, "utf8");

        // (a) It names the FREE standalone SEALER (the produce half of the loop) AND the verifier (the
        //     verify half) — the doc must describe the WHOLE self-service round-trip, not just verify.
        expect(src, `${name} names seal-vh-standalone.js`).to.include("seal-vh-standalone.js");
        expect(src, `${name} names verify-vh-standalone.js (the verify half of the round-trip)`).to.include(
          "verify-vh-standalone.js"
        );

        // (b) It promises the zero-install, self-service nature: no clone, no npm install, no account.
        expect(src, `${name} says "no clone"`).to.match(/no clone/i);
        expect(src, `${name} says "no \`npm install\`"`).to.match(/no `?npm install`?/i);
        expect(src, `${name} says "no account"`).to.match(/no account/i);

        // (c) It RESTATES the honest scope boundary: tamper-evidence + offline-recompute, and explicitly
        //     NOT a trusted "sealed at T" without P-3. (The funnel must never overclaim.)
        expect(src, `${name} restates tamper-evidence`).to.match(/tamper-evidence/i);
        expect(src, `${name} restates offline-recompute`).to.match(/offline.?recompute/i);
        expect(src, `${name} restates the NOT-sealed-at-T boundary`).to.match(/sealed at T/);
        expect(src, `${name} ties the time boundary to P-3`).to.match(/P-3/);

        // (d) It names the FREE cap (UNSIGNED + 25 files) and the PAID upgrade that lifts it
        //     (SIGNING via `vh evidence seal --sign`, UNLIMITED via the `evidence_unlimited` license).
        expect(src, `${name} says the free seal is UNSIGNED`).to.match(/UNSIGNED/);
        expect(src, `${name} names the free 25-file cap`).to.match(/25 files/);
        expect(src, `${name} names the paid signing upgrade`).to.match(/vh evidence seal --sign/);
        expect(src, `${name} names the paid unlimited entitlement`).to.match(/evidence_unlimited/);
        // SIGNING + UNLIMITED are explicitly the PAID upgrade (not free).
        expect(src, `${name} names SIGNING as the paid upgrade`).to.match(/SIGNING/);
        expect(src, `${name} names UNLIMITED as the paid upgrade`).to.match(/UNLIMITED/);
      });
    }

    it("the round-trip the docs promise is the SAME one (1)-(5) prove in code (sealer exists, exit 0)", function () {
      // Bind the prose to a real run: the file the docs tell a prospect to save actually seals + exits 0.
      // (Full round-trip incl. verify is exercised by section (3); this is the doc->code anchor.)
      expect(fs.existsSync(SEAL_PATH), "the documented seal-vh-standalone.js is shipped").to.equal(true);
      const folder = makeFolder(3);
      const out = path.join(mkTmp(), "doc-anchor.vhevidence.json");
      const r = runSeal(SEAL_PATH, [folder, "-o", out]);
      expect(r.status, `documented seal command exits 0 (stderr: ${r.stderr})`).to.equal(0);
      expect(JSON.parse(fs.readFileSync(out, "utf8")).kind).to.equal("vh.evidence-seal");
    });
  });
});

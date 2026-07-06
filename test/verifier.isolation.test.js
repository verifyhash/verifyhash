"use strict";

// test/verifier.isolation.test.js — T-31.3: PROVE the independent-verifier claim MECHANICALLY.
//
// WHY THIS TEST EXISTS
//   `verify-vh` is a buyer deliverable: a NON-customer counterparty runs it to check a sealed artifact
//   WITHOUT the producer's stack and WITHOUT any network call. docs/INDEPENDENT-VERIFICATION.md and
//   verifier/README.md make that promise in prose; this suite makes it TRUE in code, so the prose can
//   never silently drift from reality. Two independent proofs:
//
//   (1) STATIC ISOLATION — grep EVERY `require(` across the whole verifier/ tree and assert none resolves
//       to a forbidden module: ethers, hardhat, @nomicfoundation/*, OR a back-edge into cli/ or
//       trustledger/. (The only runtime dep allowed is js-sha3.) We walk the real transitive graph by
//       resolving relative requires, AND we belt-and-suspenders grep every file on disk under verifier/.
//
//   (2) RUNTIME NO-NETWORK — spawn a REAL `verify-vh` run in a child process whose Node is preloaded with
//       a guard that THROWS if anything tries to open a socket / DNS lookup / http(s) request. A clean
//       exit 0 over a real signed fixture proves the verifier opened NO network handle. We ALSO statically
//       assert the source never `require`s http/https/net/dns/tls.
//
// All keys are EPHEMERAL Wallet.createRandom() (TEST-ONLY — never a real key / real funds).

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { Wallet } = require("ethers");
const evidence = require("../cli/evidence");

const VERIFIER_DIR = path.resolve(__dirname, "..", "verifier");
const ENTRY = path.join(VERIFIER_DIR, "verify-vh.js");

// Forbidden producer-stack modules, and a back-edge into the producer's own source trees.
const FORBIDDEN_MODULE = /^(ethers|hardhat|@nomicfoundation)/;
const BACK_EDGE = /(^|[\\/])(cli|trustledger)([\\/]|$)/;
// Network modules the OFFLINE verifier must never pull (bare or node: prefixed).
const NETWORK_MODULE = /^(node:)?(http|https|net|dns|tls|http2|dgram)$/;

// Collect every `require("…")` / `require('…')` specifier from a source string.
function requireSpecifiers(src) {
  return [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
}

// Every *.js file physically under verifier/ (skip node_modules — that is leaf deps, not OUR code).
function verifierSourceFiles() {
  const out = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules") continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name.endsWith(".js")) out.push(p);
    }
  })(VERIFIER_DIR);
  return out;
}

describe("verifier isolation: no producer stack, no network back-edge (T-31.3)", function () {
  // --------------------------------------------------------------------------------------------
  // (1) STATIC ISOLATION — walk the real transitive module graph from the entrypoint.
  // --------------------------------------------------------------------------------------------
  describe("static: every require() in verifier/ is independent", function () {
    it("the transitive module graph from verify-vh.js requires no forbidden/back-edge/network module", function () {
      const seen = new Set();
      (function walk(absFile) {
        if (seen.has(absFile)) return;
        seen.add(absFile);
        // Every walked file must physically live under verifier/ (no escaping into the producer tree).
        expect(absFile, `${absFile} is outside verifier/`).to.match(/[\\/]verifier[\\/]/);
        const specs = requireSpecifiers(fs.readFileSync(absFile, "utf8"));
        for (const spec of specs) {
          const where = `${path.relative(VERIFIER_DIR, absFile)} requires "${spec}"`;
          expect(spec, where).to.not.match(FORBIDDEN_MODULE);
          expect(spec, where).to.not.match(BACK_EDGE);
          expect(spec, where).to.not.match(NETWORK_MODULE);
          // Recurse only into the verifier's OWN relative modules; a bare name (js-sha3) is a leaf dep.
          if (spec.startsWith(".")) {
            walk(require.resolve(path.resolve(path.dirname(absFile), spec)));
          }
        }
      })(require.resolve(ENTRY));

      // Sanity: we actually walked the entrypoint + its lib siblings (the test isn't vacuously passing).
      expect([...seen].some((p) => /verify-vh\.js$/.test(p)), "walked verify-vh.js").to.equal(true);
      expect([...seen].some((p) => /lib[\\/]secp256k1-recover\.js$/.test(p)), "walked secp256k1-recover").to.equal(true);
      expect([...seen].some((p) => /lib[\\/]merkle\.js$/.test(p)), "walked merkle").to.equal(true);
      expect([...seen].some((p) => /lib[\\/]canonical\.js$/.test(p)), "walked canonical").to.equal(true);
    });

    it("EVERY *.js file on disk under verifier/ (belt-and-suspenders grep) is independent", function () {
      const files = verifierSourceFiles();
      expect(files.length, "found verifier source files").to.be.greaterThan(0);
      for (const f of files) {
        for (const spec of requireSpecifiers(fs.readFileSync(f, "utf8"))) {
          const where = `${path.relative(VERIFIER_DIR, f)} requires "${spec}"`;
          expect(spec, where).to.not.match(FORBIDDEN_MODULE);
          expect(spec, where).to.not.match(BACK_EDGE);
          expect(spec, where).to.not.match(NETWORK_MODULE);
        }
      }
    });

    it("verifier/package.json declares ONLY js-sha3 (no producer stack)", function () {
      const pkg = JSON.parse(fs.readFileSync(path.join(VERIFIER_DIR, "package.json"), "utf8"));
      expect(Object.keys(pkg.dependencies || {})).to.deep.equal(["js-sha3"]);
      const all = JSON.stringify({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
      expect(all).to.not.match(FORBIDDEN_MODULE);
    });
  });

  // --------------------------------------------------------------------------------------------
  // (2) RUNTIME NO-NETWORK — a real verify run in a hardened child opens NO socket / DNS handle.
  // --------------------------------------------------------------------------------------------
  describe("runtime: a real verify run opens no socket / network handle", function () {
    const tmpDirs = [];
    after(function () {
      for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    });
    function mkTmp() {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-isolation-"));
      tmpDirs.push(d);
      return d;
    }

    // A real signed evidence packet via the REAL producer CLI path. Returns { packet, vendor }.
    async function makeSignedPacket() {
      const root = mkTmp();
      const dir = path.join(root, "data");
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "model-card.md"), "# Model Card\nv1\n");
      fs.writeFileSync(path.join(dir, "weights.bin"), Buffer.from([0, 1, 2, 255, 7]));

      const vendorWallet = Wallet.createRandom();
      const license = await evidence.buildLicense(
        {
          licenseId: "EV-ISO-1",
          customer: "ACME",
          plan: "pro",
          entitlements: ["evidence_signed"],
          issuedAt: "2026-06-01T00:00:00.000Z",
          expiresAt: "2027-06-01T00:00:00.000Z",
        },
        vendorWallet
      );
      const licFile = path.join(root, "evidence.vhlicense.json");
      fs.writeFileSync(licFile, JSON.stringify(license) + "\n");

      const opWallet = Wallet.createRandom();
      const keyEnv = "VFY_ISO_KEY_" + Math.random().toString(36).slice(2);
      process.env[keyEnv] = opWallet.privateKey;
      const packet = path.join(dir, "packet.vhevidence.json");
      const now = new Date("2026-06-24T00:00:00.000Z");
      let code;
      try {
        code = await evidence.runEvidenceSeal(
          { dir, out: packet, sign: true, keyEnv, license: licFile, vendor: vendorWallet.address, now },
          // T-75.3: the ephemeral key is THIS run's CANONICAL vendor identity (programmatic seam).
          { write: () => {}, writeErr: () => {}, now, canonicalVendor: vendorWallet.address }
        );
      } finally {
        delete process.env[keyEnv];
      }
      expect(code, "producer evidence CLI succeeded").to.equal(0);
      return { packet, vendor: opWallet.address };
    }

    // A Node preload module that POISONS every OUTBOUND network primitive: any attempt to OPEN a
    // connection (net/tls connect), do a DNS lookup, or fire an http(s)/http2 request throws
    // synchronously. If verify-vh touched the network the child would crash (non-zero exit); a clean
    // exit 0 PROVES it did not.
    //
    // NOTE we poison the *connection-establishing* functions, NOT the `net.Socket` constructor — Node's
    // own `process.stdout`/`stdin` are internally `net.Socket` pipes (local, not network), so trapping
    // the constructor would be a false positive. `connect`/`createConnection`/`request`/`get`/`lookup`
    // are the functions that actually reach the network.
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

    it("verify-vh accepts a real signed packet with the network poisoned (exit 0, no socket opened)", async function () {
      const { packet, vendor } = await makeSignedPacket();
      const guard = writeNetworkGuard(path.dirname(packet));

      const res = spawnSync(process.execPath, ["--require", guard, ENTRY, packet, "--vendor", vendor, "--json"], {
        encoding: "utf8",
      });

      // No crash from the guard, clean accept.
      expect(res.error, "no spawn error").to.equal(undefined);
      const combined = (res.stdout || "") + (res.stderr || "");
      expect(combined, "guard never tripped").to.not.match(/NETWORK ACCESS ATTEMPTED/);
      expect(res.status, `exit 0 (out: ${combined})`).to.equal(0);
      const verdict = JSON.parse(res.stdout);
      expect(verdict.accepted).to.equal(true);
      expect(verdict.verdict).to.equal("OK");
    });

    it("the network guard actually trips when SOMETHING does touch the network (the guard is not a no-op)", function () {
      const dir = mkTmp();
      const guard = writeNetworkGuard(dir);
      // A throwaway script that DOES attempt a connection; with the guard preloaded it must crash.
      const offender = path.join(dir, "offender.cjs");
      fs.writeFileSync(offender, "require('http').get('http://127.0.0.1:9/');\n");
      const res = spawnSync(process.execPath, ["--require", guard, offender], { encoding: "utf8" });
      expect(res.status, "offender crashed").to.not.equal(0);
      expect((res.stdout || "") + (res.stderr || "")).to.match(/NETWORK ACCESS ATTEMPTED/);
    });
  });
});

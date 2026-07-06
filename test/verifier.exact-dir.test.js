"use strict";

// test/verifier.exact-dir.test.js — the acceptance suite for `verify-vh --exact-dir` (T-75.5).
//
// THE GAP THIS PINS SHUT (supervisor-verified): an evidence seal binds a NAMED FILE SET, not a
// directory boundary — so by design, dropping `EVIL-injected.sh` into a sealed directory left the
// default verdict "OK", exit 0, while the output's "0 unexpected" read as "the whole directory is
// vouched for". That combination overclaimed the CI build-gating pitch. This suite proves the fix:
//   * DEFAULT (no flag): the named-file semantics are UNCHANGED — an injected extra still exits 0 —
//     but the output now states the boundary ("NOT covered … use --exact-dir") and no longer prints
//     a misleading "0 unexpected" for a scan that never ran;
//   * --exact-dir: the WHOLE directory is scanned and any file present-on-disk-but-not-in-the-seal
//     is REJECTED (exit 3, reason UNEXPECTED) with the offending path NAMED and the `unexpected`
//     counter genuinely populated;
//   * a genuine artifact still ACCEPTs BOTH ways (the artifact file itself is exempt from the scan);
//   * kinds with no sealed directory (agent packet, --anchored-artifact) reject the flag as a NAMED
//     usage error (exit 2), never a silently-ignored flag;
//   * the frozen cross-implementation `extra-file` conformance vector (verify-vectors/, EPIC-77's
//     documented shared gap) goes GREEN for the JS implementation under --exact-dir.
//
// FILESYSTEM HYGIENE: every write lands under a throwaway temp dir cleaned in afterEach; the
// conformance-vector case is verified READ-ONLY in place (verify-vh writes nothing).

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { Wallet } = require("ethers");

const trustSeal = require("../trustledger/seal");
const verifyvh = require("../verifier/verify-vh");

const REPO = path.join(__dirname, "..");
const VECTORS_DIR = path.join(REPO, "verify-vectors");

describe("verify-vh --exact-dir: the whole-directory fail-closed gate (T-75.5)", function () {
  let tmpDirs;

  beforeEach(function () {
    tmpDirs = [];
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-exactdir-"));
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

  // Materialize the shipped GENUINELY-SIGNED demo evidence packet + its two sealed files into a fresh
  // temp dir (the same fixture `verify-vh demo` plays through the real verify path). The packet sits
  // INSIDE the sealed directory, exactly like a release layout — so these cases also prove the
  // artifact-self-exemption (a seal never names its own container).
  function stageSignedPacket() {
    const dir = mkTmp();
    for (const [rel, content] of Object.entries(verifyvh.DEMO_FILES)) {
      fs.writeFileSync(path.join(dir, rel), content);
    }
    const packetPath = path.join(dir, "packet.vhevidence.json");
    fs.writeFileSync(packetPath, JSON.stringify(verifyvh.DEMO_CONTAINER, null, 2));
    return { dir, packetPath };
  }

  // Same files, but the BARE (unsigned) seal — the signed container's embedded attestation IS the
  // canonical bare `vh.evidence-seal` JSON.
  function stageBareSeal() {
    const dir = mkTmp();
    for (const [rel, content] of Object.entries(verifyvh.DEMO_FILES)) {
      fs.writeFileSync(path.join(dir, rel), content);
    }
    const packetPath = path.join(dir, "bare.vhevidence.json");
    fs.writeFileSync(packetPath, verifyvh.DEMO_CONTAINER.attestation);
    return { dir, packetPath };
  }

  // ================================================================================================
  // (1) GENUINE cases ACCEPT both ways (default AND --exact-dir) — the positive gate stays green.
  // ================================================================================================
  describe("a genuine sealed directory ACCEPTs with and without --exact-dir", function () {
    it("signed packet, default: exit 0", function () {
      const { packetPath } = stageSignedPacket();
      const c = cap();
      expect(verifyvh.run([packetPath], c.io), c.err()).to.equal(verifyvh.EXIT.OK);
      expect(c.out()).to.match(/OK — the artifact verifies\./);
    });

    it("signed packet, --exact-dir (+ --vendor pin): exit 0 — the artifact file itself is exempt from the scan", function () {
      const { packetPath } = stageSignedPacket();
      const c = cap();
      const code = verifyvh.run(
        [packetPath, "--exact-dir", "--vendor", verifyvh.DEMO_SIGNER, "--json"],
        c.io
      );
      expect(code, c.err()).to.equal(verifyvh.EXIT.OK);
      const r = JSON.parse(c.out());
      expect(r.accepted).to.equal(true);
      expect(r.exactDir, "the verdict must say the whole-directory scan ran").to.equal(true);
      expect(r.unexpected).to.deep.equal([]);
      expect(r.counts.unexpected).to.equal(0);
    });

    it("bare (unsigned) seal, --exact-dir: exit 0 on the genuine set", function () {
      const { packetPath } = stageBareSeal();
      const c = cap();
      expect(verifyvh.run([packetPath, "--exact-dir"], c.io), c.err()).to.equal(verifyvh.EXIT.OK);
    });
  });

  // ================================================================================================
  // (2) The INJECTED-EXTRA-FILE gap: default semantics unchanged (exit 0, boundary stated);
  //     --exact-dir REJECTs (exit 3) naming the path, counter populated.
  // ================================================================================================
  describe("an injected extra file in the sealed directory", function () {
    it("DEFAULT: still exit 0 (named-file semantics unchanged) — but the output states the boundary instead of '0 unexpected'", function () {
      const { dir, packetPath } = stageSignedPacket();
      fs.writeFileSync(path.join(dir, "EVIL-injected.sh"), "#!/bin/sh\necho pwned\n");
      const c = cap();
      const code = verifyvh.run([packetPath], c.io);
      expect(code, "the default named-set semantics must NOT change (opt-in flag only)").to.equal(
        verifyvh.EXIT.OK
      );
      // The reworded default output: it must say what IS and is NOT covered, and point at the flag…
      expect(c.out()).to.match(/of the 2 files the seal NAMES/);
      expect(c.out()).to.match(/other files in this directory are\nNOT covered/);
      expect(c.out()).to.match(/--exact-dir/);
      // …and must NOT print an "unexpected" tally for a directory scan that never ran.
      expect(c.out(), "no misleading '0 unexpected' without a scan").to.not.match(/0 unexpected/);
    });

    it("DEFAULT --json: shape unchanged (no exactDir marker, unexpected stays an empty list) — a stable contract", function () {
      const { dir, packetPath } = stageSignedPacket();
      fs.writeFileSync(path.join(dir, "EVIL-injected.sh"), "#!/bin/sh\necho pwned\n");
      const c = cap();
      expect(verifyvh.run([packetPath, "--json"], c.io)).to.equal(verifyvh.EXIT.OK);
      const r = JSON.parse(c.out());
      expect(r.accepted).to.equal(true);
      expect(r.unexpected).to.deep.equal([]);
      expect(r.counts.unexpected).to.equal(0);
      expect(r).to.not.have.property("exactDir");
    });

    it("--exact-dir: REJECT (exit 3), reason UNEXPECTED, the offending path NAMED, counter populated", function () {
      const { dir, packetPath } = stageSignedPacket();
      fs.writeFileSync(path.join(dir, "EVIL-injected.sh"), "#!/bin/sh\necho pwned\n");
      const c = cap();
      const code = verifyvh.run([packetPath, "--exact-dir", "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      const r = JSON.parse(c.out());
      expect(r.verdict).to.equal("REJECTED");
      expect(r.reason).to.equal("UNEXPECTED");
      expect(r.accepted).to.equal(false);
      expect(r.exactDir).to.equal(true);
      expect(r.unexpected).to.deep.equal([{ relPath: "EVIL-injected.sh" }]);
      expect(r.counts.unexpected).to.equal(1);
      // The sealed files themselves were untouched.
      expect(r.counts.matched).to.equal(2);
      expect(r.counts.changed).to.equal(0);
      expect(r.rootMatches).to.equal(true);

      // Human output names the file too.
      const h = cap();
      expect(verifyvh.run([packetPath, "--exact-dir"], h.io)).to.equal(verifyvh.EXIT.REJECTED);
      expect(h.out()).to.match(/REJECTED \(UNEXPECTED\)/);
      expect(h.out()).to.match(/UNEXPECTED EVIL-injected\.sh: present in the directory but NOT named by the seal/);
    });

    it("--exact-dir finds NESTED extras too (recursive scan, forward-slash relPath)", function () {
      const { dir, packetPath } = stageSignedPacket();
      fs.mkdirSync(path.join(dir, "sub", "deep"), { recursive: true });
      fs.writeFileSync(path.join(dir, "sub", "deep", "evil.txt"), "extra");
      const c = cap();
      expect(verifyvh.run([packetPath, "--exact-dir", "--json"], c.io)).to.equal(verifyvh.EXIT.REJECTED);
      const r = JSON.parse(c.out());
      expect(r.unexpected).to.deep.equal([{ relPath: "sub/deep/evil.txt" }]);
    });

    it("a structural tamper KEEPS its dominant reason (CHANGED) while the unexpected list still rides along", function () {
      const { dir, packetPath } = stageSignedPacket();
      fs.writeFileSync(path.join(dir, "weights.txt"), "9.99 9.99 9.99\n"); // tamper a sealed file
      fs.writeFileSync(path.join(dir, "EVIL-injected.sh"), "extra"); // AND inject an extra
      const c = cap();
      expect(verifyvh.run([packetPath, "--exact-dir", "--json"], c.io)).to.equal(verifyvh.EXIT.REJECTED);
      const r = JSON.parse(c.out());
      expect(r.reason, "a content tamper dominates the reason").to.equal("CHANGED");
      expect(r.changed.map((x) => x.relPath)).to.deep.equal(["weights.txt"]);
      expect(r.unexpected).to.deep.equal([{ relPath: "EVIL-injected.sh" }]);
      expect(r.counts.unexpected).to.equal(1);
    });

    it("--exact-dir + --strict: a directory-boundary REJECT (3) dominates UNPINNED (4); a clean-but-unpinned accept still fails closed as 4", function () {
      const { dir, packetPath } = stageSignedPacket();
      // Clean directory, no vendor pin, strict + exact-dir -> UNPINNED (4), not OK.
      let c = cap();
      expect(verifyvh.run([packetPath, "--exact-dir", "--strict"], c.io)).to.equal(verifyvh.EXIT.UNPINNED);
      // Injected extra, pinned vendor, strict + exact-dir -> the genuine REJECT (3) wins.
      fs.writeFileSync(path.join(dir, "EVIL-injected.sh"), "extra");
      c = cap();
      expect(
        verifyvh.run([packetPath, "--exact-dir", "--strict", "--vendor", verifyvh.DEMO_SIGNER], c.io)
      ).to.equal(verifyvh.EXIT.REJECTED);
    });
  });

  // ================================================================================================
  // (3) TRUST/reconciliation seals get the same boundary (they also bind a named file set).
  // ================================================================================================
  describe("trust (reconciliation) seals under --exact-dir", function () {
    async function makeSignedTrustSeal() {
      const root = mkTmp();
      fs.writeFileSync(path.join(root, "bank.csv"), "date,amount\n2026-06-01,100\n");
      fs.writeFileSync(path.join(root, "book.csv"), "date,amount\n2026-06-01,100\n");
      fs.writeFileSync(path.join(root, "report.html"), "<html><body>reconciled</body></html>");
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
      const opWallet = Wallet.createRandom();
      const container = await trustSeal.signSealWith(bare, opWallet);
      const sealPath = path.join(root, "recon.vhseal");
      fs.writeFileSync(sealPath, trustSeal.serializeSignedSeal(container));
      return { root, sealPath, opWallet };
    }

    it("genuine: ACCEPT (exit 0) — the seal file itself is exempt", async function () {
      const { sealPath, opWallet } = await makeSignedTrustSeal();
      const c = cap();
      expect(
        verifyvh.run([sealPath, "--exact-dir", "--vendor", opWallet.address], c.io),
        c.err()
      ).to.equal(verifyvh.EXIT.OK);
    });

    it("injected extra: REJECT (exit 3) naming the path", async function () {
      const { root, sealPath, opWallet } = await makeSignedTrustSeal();
      fs.writeFileSync(path.join(root, "EVIL-injected.sh"), "extra");
      const c = cap();
      expect(
        verifyvh.run([sealPath, "--exact-dir", "--vendor", opWallet.address, "--json"], c.io)
      ).to.equal(verifyvh.EXIT.REJECTED);
      const r = JSON.parse(c.out());
      expect(r.reason).to.equal("UNEXPECTED");
      expect(r.unexpected).to.deep.equal([{ relPath: "EVIL-injected.sh" }]);
    });
  });

  // ================================================================================================
  // (4) BATCH mode: --exact-dir applies to every entry; one injected extra fails the whole gate.
  // ================================================================================================
  describe("batch mode under --exact-dir", function () {
    it("two artifacts, one with an injected extra -> aggregate exit 3, the batch report names the path", function () {
      const a = stageSignedPacket();
      const b = stageSignedPacket();
      fs.writeFileSync(path.join(b.dir, "EVIL-injected.sh"), "extra");
      const c = cap();
      const code = verifyvh.run([a.packetPath, b.packetPath, "--exact-dir"], c.io);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      expect(c.out()).to.match(/PASS {2}.*packet\.vhevidence\.json/);
      expect(c.out()).to.match(/FAIL {2}.*packet\.vhevidence\.json {2}\(UNEXPECTED\)/);
      expect(c.out()).to.match(/UNEXPECTED EVIL-injected\.sh: in the directory but NOT named by the seal \(--exact-dir\)/);
    });

    it("both clean -> aggregate exit 0", function () {
      const a = stageSignedPacket();
      const b = stageSignedPacket();
      const c = cap();
      expect(verifyvh.run([a.packetPath, b.packetPath, "--exact-dir"], c.io), c.err()).to.equal(
        verifyvh.EXIT.OK
      );
    });
  });

  // ================================================================================================
  // (5) NAMED usage errors — the flag is never silently ignored where it cannot mean anything.
  // ================================================================================================
  describe("named usage errors (exit 2), never a silently-ignored flag", function () {
    it("--exact-dir on a self-contained agent-session packet", function () {
      const dir = mkTmp();
      const pkt = path.join(dir, "session.vhagent.json");
      fs.writeFileSync(pkt, verifyvh.DEMO_AGENT_PACKET_TEXT);
      const c = cap();
      expect(verifyvh.run([pkt, "--exact-dir"], c.io)).to.equal(verifyvh.EXIT.USAGE);
      expect(c.err()).to.match(/--exact-dir applies to artifacts that bind a NAMED FILE SET/);
      // Sanity: the same packet verifies fine without the flag.
      const ok = cap();
      expect(verifyvh.run([pkt], ok.io), ok.err()).to.equal(verifyvh.EXIT.OK);
    });

    it("--exact-dir combined with --anchored-artifact", function () {
      const c = cap();
      expect(
        verifyvh.run(["receipt.json", "--anchored-artifact", "sealed.json", "--exact-dir"], c.io)
      ).to.equal(verifyvh.EXIT.USAGE);
      expect(c.err()).to.match(/--exact-dir does not apply to the anchored-receipt binding check/);
    });
  });

  // ================================================================================================
  // (6) The frozen cross-implementation `extra-file` conformance vector (the 6th vector, EPIC-77's
  //     documented shared gap) goes GREEN for the JS implementation under --exact-dir. READ-ONLY.
  // ================================================================================================
  describe("the frozen `extra-file` conformance vector (verify-vectors/)", function () {
    it("REJECTs (exit 3, reason UNEXPECTED) under --exact-dir, naming UNEXPECTED-injected.txt — and stays exit 0 without the flag (the by-design named-set default)", function () {
      const vectors = JSON.parse(fs.readFileSync(path.join(VECTORS_DIR, "vectors.json"), "utf8"));
      const cases = vectors.cases || vectors; // tolerate either container shape
      const vec = (Array.isArray(cases) ? cases : []).find((v) => v.name === "extra-file");
      expect(vec, "verify-vectors/vectors.json must carry the extra-file case").to.not.equal(undefined);
      const packet = path.join(VECTORS_DIR, vec.packetRelPath);
      const filesDir = path.join(VECTORS_DIR, vec.filesDirRelPath);

      // Without the flag: the named-set default (the documented pre-T-75.5 behavior) still accepts.
      const base = cap();
      expect(
        verifyvh.run([packet, "--dir", filesDir, "--vendor", vec.vendor], base.io),
        base.err()
      ).to.equal(verifyvh.EXIT.OK);

      // With --exact-dir: the vector's expected verdict (REJECT, exit 3) is now reproduced.
      const c = cap();
      const code = verifyvh.run(
        [packet, "--dir", filesDir, "--vendor", vec.vendor, "--exact-dir", "--json"],
        c.io
      );
      expect(code).to.equal(vec.expectedExit);
      const r = JSON.parse(c.out());
      expect(r.verdict).to.equal("REJECTED");
      expect(r.reason).to.equal("UNEXPECTED");
      expect(r.unexpected.map((u) => u.relPath)).to.include("UNEXPECTED-injected.txt");
    });
  });
});

"use strict";

// test/verifier.strict-unpinned.test.js — T-75.2 acceptance: FAIL-CLOSED verify — an UNPINNED signer
// must never present as marketed "real provenance".
//
// WHAT THIS PROVES (mapped to the task's acceptance clauses)
//   (1) `verify-vh` (and the producer's `vh evidence verify-signed`) WITHOUT a --vendor/--signer pin
//       still report the RECOVERED signer, but the human AND JSON verdicts state UNPINNED explicitly
//       ("signed by 0x… — NOT pinned to a trusted vendor; anyone's key passes"), and a `--strict` mode
//       turns an unpinned accept into the DISTINCT non-zero exit 4 (EXIT.UNPINNED) — fail-closed, so a
//       CI gate can never silently accept an attacker-self-signed artifact.
//   (2) the shipped CI recipes (verifier/ci/verify-vh.*) default to the pinned + --strict form and
//       document the exit-code contract (0 ACCEPT-and-pinned / 3 REJECT / 4 UNPINNED-under-strict);
//       docs/ADOPT.md documents the same contract.
//   (3) an artifact signed by an attacker's OWN key: exit 4 under --strict, and a clearly-labelled
//       UNPINNED verdict (exit 0) without it; a correctly pinned genuine artifact stays exit 0; the
//       pre-existing 0/3 contract for PINNED calls is preserved verbatim (wrong_issuer/CHANGED stay 3).
//
// POSTURE: fully OFFLINE; every key is an EPHEMERAL Wallet.createRandom() (TEST-ONLY — never a real
// key / real funds); all fixtures live under throwaway temp dirs cleaned in afterEach.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { Wallet } = require("ethers");

const trustSeal = require("../trustledger/seal");
const evidence = require("../cli/evidence");
const coreAttestation = require("../cli/core/attestation");
const verifyvh = require("../verifier/verify-vh");

const REPO = path.resolve(__dirname, "..");
const GENERIC_SH = path.join(REPO, "verifier", "ci", "verify-vh.generic.sh");
const GHA_YML = path.join(REPO, "verifier", "ci", "verify-vh.github-actions.yml");
const VERIFY_VH = path.join(REPO, "verifier", "verify-vh.js");
const ADOPT = path.join(REPO, "docs", "ADOPT.md");

// The acceptance-mandated statement, verbatim modulo the concrete address.
const UNPINNED_STATEMENT = /signed by 0x[0-9a-f]{40} — NOT pinned to a trusted vendor; anyone's key\s+passes/;

function cap() {
  const out = [];
  const err = [];
  return {
    io: { write: (s) => out.push(s), writeErr: (s) => err.push(s) },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

describe("T-75.2: fail-closed verify — UNPINNED must never present as real provenance", function () {
  this.timeout(30000);

  let tmpDirs;
  beforeEach(function () {
    tmpDirs = [];
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-strict-"));
    tmpDirs.push(d);
    return d;
  }

  // A SIGNED reconciliation seal whose siblings sit next to it. The "attacker" scenario is exactly
  // this: the packet is internally consistent and GENUINELY signed — by whatever key the producer
  // (or an attacker) happened to hold. Returns { root, sealPath, wallet }.
  async function makeSignedSeal(wallet) {
    const root = mkTmp();
    fs.writeFileSync(path.join(root, "bank.csv"), "date,amount\n2026-06-01,100\n");
    fs.writeFileSync(path.join(root, "book.csv"), "date,amount\n2026-06-01,100\n");
    fs.writeFileSync(path.join(root, "report.html"), "<html>ok</html>");
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
    const w = wallet || Wallet.createRandom(); // EPHEMERAL, TEST-ONLY
    const container = await trustSeal.signSealWith(bare, w);
    const sealPath = path.join(root, "recon.vhseal");
    fs.writeFileSync(sealPath, trustSeal.serializeSignedSeal(container));
    return { root, sealPath, wallet: w };
  }

  // A BARE (unsigned) seal — nobody vouched at all.
  function makeUnsignedSeal() {
    const root = mkTmp();
    fs.writeFileSync(path.join(root, "bank.csv"), "date,amount\n2026-06-01,100\n");
    fs.writeFileSync(path.join(root, "book.csv"), "date,amount\n2026-06-01,100\n");
    fs.writeFileSync(path.join(root, "report.html"), "<html>ok</html>");
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
    const sealPath = path.join(root, "recon.vhseal");
    fs.writeFileSync(sealPath, trustSeal.serializeSeal(bare));
    return { root, sealPath };
  }

  // ===============================================================================================
  // 1. verify-vh — the standalone verifier (the marketed CI-gate surface).
  // ===============================================================================================
  describe("verify-vh: UNPINNED labelling without a pin; --strict fails closed (exit 4)", function () {
    it("exports the new exit code: EXIT.UNPINNED === 4, distinct from the 0/1/2/3 contract", function () {
      expect(verifyvh.EXIT.UNPINNED).to.equal(4);
      expect(new Set(Object.values(verifyvh.EXIT)).size).to.equal(Object.values(verifyvh.EXIT).length);
    });

    it("ATTACKER-self-signed, NO pin, NO --strict: exit 0 but the verdict is clearly labelled UNPINNED (human + JSON)", async function () {
      const { sealPath } = await makeSignedSeal(); // an attacker's OWN ephemeral key
      // Human: recovered signer still reported; UNPINNED stated in the header AND on the verdict line.
      let c = cap();
      let code = verifyvh.run([sealPath], c.io);
      expect(code, c.err()).to.equal(verifyvh.EXIT.OK);
      expect(c.out()).to.match(/recovered signer: 0x[0-9a-f]{40}/);
      expect(c.out()).to.contain("no --vendor pin"); // the locked in-band disclosure survives
      expect(c.out()).to.match(/UNPINNED/);
      expect(c.out()).to.match(UNPINNED_STATEMENT);
      expect(c.out()).to.match(/OK — the artifact verifies\./);

      // JSON: the machine-readable verdict states UNPINNED explicitly too.
      c = cap();
      code = verifyvh.run([sealPath, "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.OK);
      const r = JSON.parse(c.out());
      expect(r.accepted).to.equal(true);
      expect(r.verdict).to.equal("OK");
      expect(r.pinning).to.equal("unpinned");
      expect(r.unpinnedNote).to.match(UNPINNED_STATEMENT);
      expect(r.recoveredSigner).to.match(/^0x[0-9a-f]{40}$/); // still reported, never hidden
    });

    it("ATTACKER-self-signed + --strict: the DISTINCT non-zero exit 4 with verdict UNPINNED (fail-closed)", async function () {
      const { sealPath } = await makeSignedSeal();
      const c = cap();
      const code = verifyvh.run([sealPath, "--strict", "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.UNPINNED);
      expect(code).to.equal(4);
      const r = JSON.parse(c.out());
      expect(r.verdict).to.equal("UNPINNED");
      expect(r.reason).to.equal("unpinned_signer");
      expect(r.accepted).to.equal(false);
      expect(r.strict).to.equal(true);
      expect(r.pinning).to.equal("unpinned");
      // The INTEGRITY facts stay honest on the result: the bytes DID verify; only the pin is missing.
      expect(r.rootMatches).to.equal(true);
      expect(r.signatureOk).to.equal(true);

      // Human form names the fail-closed verdict + the reason.
      const c2 = cap();
      expect(verifyvh.run([sealPath, "--strict"], c2.io)).to.equal(4);
      expect(c2.out()).to.match(/UNPINNED \(unpinned_signer\) — fail-closed under --strict \(exit 4\)/);
      expect(c2.out()).to.match(UNPINNED_STATEMENT);
    });

    it("a correctly PINNED genuine artifact stays exit 0 — with AND without --strict (no regression)", async function () {
      const { sealPath, wallet } = await makeSignedSeal();
      for (const args of [
        [sealPath, "--vendor", wallet.address],
        [sealPath, "--vendor", wallet.address, "--strict"],
      ]) {
        const c = cap();
        const code = verifyvh.run(args.concat(["--json"]), c.io);
        expect(code, c.err()).to.equal(verifyvh.EXIT.OK);
        const r = JSON.parse(c.out());
        expect(r.verdict).to.equal("OK");
        expect(r.pinning).to.equal("pinned");
        expect(r.unpinnedNote).to.equal(undefined);
      }
    });

    it("PINNED calls keep the 0/3 contract verbatim: wrong_issuer and CHANGED stay exit 3 under --strict", async function () {
      const { root, sealPath, wallet } = await makeSignedSeal();
      const legit = Wallet.createRandom(); // the producer the victim SHOULD have been handed

      // wrong_issuer: pinned to the legitimate producer, artifact signed by the attacker.
      for (const extra of [[], ["--strict"]]) {
        const c = cap();
        const code = verifyvh.run([sealPath, "--vendor", legit.address, "--json"].concat(extra), c.io);
        expect(code).to.equal(verifyvh.EXIT.REJECTED);
        const r = JSON.parse(c.out());
        expect(r.reason).to.equal("wrong_issuer");
        expect(r.pinning).to.equal("pin_failed");
      }

      // CHANGED: tampered bytes under the correct pin — REJECT (3), never UNPINNED (4).
      fs.writeFileSync(path.join(root, "bank.csv"), "date,amount\n2026-06-01,999\n");
      const c = cap();
      const code = verifyvh.run([sealPath, "--vendor", wallet.address, "--strict", "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      expect(JSON.parse(c.out()).reason).to.equal("CHANGED");
    });

    it("an UNSIGNED artifact under --strict is also fail-closed (exit 4, unpinned_unsigned) — nobody vouched", function () {
      const { sealPath } = makeUnsignedSeal();
      // Without --strict: accepted, but labelled UNPINNED/unsigned in human + JSON.
      let c = cap();
      let code = verifyvh.run([sealPath, "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.OK);
      let r = JSON.parse(c.out());
      expect(r.pinning).to.equal("unpinned");
      expect(r.unpinnedNote).to.contain("UNSIGNED");
      c = cap();
      verifyvh.run([sealPath], c.io);
      expect(c.out()).to.match(/UNPINNED — unsigned artifact, no vendor pin/);

      // With --strict: the distinct fail-closed exit.
      c = cap();
      code = verifyvh.run([sealPath, "--strict", "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.UNPINNED);
      r = JSON.parse(c.out());
      expect(r.verdict).to.equal("UNPINNED");
      expect(r.reason).to.equal("unpinned_unsigned");
    });

    it("agent-session packets ride the same rails: the unsigned demo packet is UNPINNED under --strict", function () {
      const dir = mkTmp();
      const pkt = path.join(dir, verifyvh.DEMO_AGENT_PACKET_NAME);
      fs.writeFileSync(pkt, verifyvh.DEMO_AGENT_PACKET_TEXT);
      let c = cap();
      expect(verifyvh.run([pkt, "--json"], c.io)).to.equal(verifyvh.EXIT.OK);
      expect(JSON.parse(c.out()).pinning).to.equal("unpinned");
      c = cap();
      expect(verifyvh.run([pkt, "--strict", "--json"], c.io)).to.equal(verifyvh.EXIT.UNPINNED);
      expect(JSON.parse(c.out()).verdict).to.equal("UNPINNED");
    });

    it("BATCH under --strict: unpinned entries fail the whole gate closed (exit 4); a genuine REJECT still dominates (exit 3)", async function () {
      const a = await makeSignedSeal();
      const b = await makeSignedSeal();

      // Two accepted-but-unpinned entries -> aggregate UNPINNED, exit 4, tallied + labelled.
      let c = cap();
      let code = verifyvh.run([a.sealPath, b.sealPath, "--strict", "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.UNPINNED);
      const agg = JSON.parse(c.out());
      expect(agg.ok).to.equal(false);
      expect(agg.unpinned).to.equal(2);
      expect(agg.failed).to.equal(2);
      expect(agg.results.every((r) => r.verdict === "UNPINNED")).to.equal(true);

      c = cap();
      verifyvh.run([a.sealPath, b.sealPath, "--strict"], c.io);
      expect(c.out()).to.match(/UNPINNED {2}.*recon\.vhseal/);
      expect(c.out()).to.match(/2 UNPINNED under --strict/);
      expect(c.out()).to.match(/UNPINNED — 2 artifact\(s\) verified WITHOUT a trusted --vendor pin/);

      // One entry pinned to the WRONG vendor (a real REJECT) + one unpinned: REJECT (3) dominates.
      const manifest = path.join(mkTmp(), "release.manifest");
      fs.writeFileSync(
        manifest,
        `${a.sealPath}\n${b.sealPath} --vendor ${Wallet.createRandom().address}\n`
      );
      c = cap();
      code = verifyvh.run(["--manifest", manifest, "--strict", "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      const agg2 = JSON.parse(c.out());
      expect(agg2.unpinned).to.equal(1);
      expect(agg2.failed).to.equal(2);

      // WITHOUT --strict the batch aggregate keeps its historical shape semantics: all pass, exit 0.
      c = cap();
      code = verifyvh.run([a.sealPath, b.sealPath, "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.OK);
      const agg3 = JSON.parse(c.out());
      expect(agg3.ok).to.equal(true);
      expect(agg3.unpinned).to.equal(0);
    });

    it("--strict composes only where a pin means something: with --anchored-artifact it is a NAMED usage error (2)", function () {
      const c = cap();
      const code = verifyvh.run(["r.json", "--anchored-artifact", "s.json", "--strict"], c.io);
      expect(code).to.equal(verifyvh.EXIT.USAGE);
      expect(c.err()).to.match(/--strict does not apply to the anchored-receipt binding check/);
    });

    it("usage() documents the contract: --strict flag + exit 4 UNPINNED", function () {
      const u = verifyvh.usage();
      expect(u).to.contain("--strict");
      expect(u).to.match(/4 UNPINNED/);
      expect(u).to.match(/anyone's key/);
    });
  });

  // ===============================================================================================
  // 2. The shipped CI recipes default to the PINNED + STRICT form and document the contract.
  // ===============================================================================================
  describe("shipped CI recipes: pinned + --strict by default; exit contract documented", function () {
    it("verify-vh.generic.sh passes --strict alongside the REQUIRED vendor pin and documents exit 4", function () {
      const src = fs.readFileSync(GENERIC_SH, "utf8");
      expect(src).to.match(/--vendor "\$VH_VENDOR" --strict/);
      expect(src).to.match(/4 {2}UNPINNED/);
      expect(src).to.match(/ACCEPT-and-pinned|ACCEPT-AND-PINNED/i);
      // The pin stays REQUIRED (a missing VH_VENDOR is exit 2, proven by verifier.ci-snippet.test.js).
      expect(src).to.match(/set VH_VENDOR/);
    });

    it("verify-vh.github-actions.yml gate command carries BOTH --vendor and --strict and documents exit 4", function () {
      const yml = fs.readFileSync(GHA_YML, "utf8");
      const runLine = yml.split("\n").find((l) => l.includes("verify-vh.js") && l.includes("--manifest"));
      expect(runLine, "the yml must ship the gate command").to.not.equal(undefined);
      expect(runLine).to.contain("--vendor");
      expect(runLine).to.contain("--strict");
      expect(yml).to.match(/4 {2}UNPINNED/);
    });

    it("the generic gate, run VERBATIM with --strict active: genuine+pinned exit 0; tampered exit 3 (0/3 preserved)", async function () {
      const { root, sealPath, wallet } = await makeSignedSeal();
      const env = { ...process.env, VERIFY_VH, VH_VENDOR: wallet.address, VH_ARTIFACTS: sealPath };
      const run = () => {
        try {
          const stdout = execFileSync("bash", [GENERIC_SH], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
          return { code: 0, stdout };
        } catch (e) {
          return { code: typeof e.status === "number" ? e.status : 1, stdout: String(e.stdout || "") };
        }
      };
      const good = run();
      expect(good.code, good.stdout).to.equal(0);
      fs.writeFileSync(path.join(root, "bank.csv"), "date,amount\n2026-06-01,999\n");
      expect(run().code).to.equal(3);
    });

    it("docs/ADOPT.md documents the exit contract (0 ACCEPT-and-pinned / 3 REJECT / 4 UNPINNED) + the strict one-liner", function () {
      const md = fs.readFileSync(ADOPT, "utf8");
      expect(md).to.contain("--strict");
      expect(md).to.contain("ACCEPT-and-pinned");
      expect(md).to.match(/4.{0,40}UNPINNED|UNPINNED.{0,40}4/s);
      expect(md).to.match(/anyone's key passes/);
    });
  });

  // ===============================================================================================
  // 3. The producer-side `vh evidence verify-signed` — same fail-closed discipline via --signer.
  // ===============================================================================================
  describe("vh evidence verify-signed: UNPINNED labelling + --strict (exit 4)", function () {
    async function makeSignedEvidencePacket(wallet) {
      const root = mkTmp();
      const dir = path.join(root, "payload");
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "AAA\n");
      fs.writeFileSync(path.join(dir, "b.txt"), "BBB\n");
      const w = wallet || Wallet.createRandom(); // EPHEMERAL, TEST-ONLY
      const entries = evidence.loadDirEntries(dir);
      const seal = evidence.buildSeal(entries);
      const container = await evidence.signSealWith(seal, w);
      const packetPath = path.join(root, "signed.vhevidence.json");
      fs.writeFileSync(packetPath, coreAttestation.serializeSignedAttestation(container, evidence.SIGNED_SEAL_CFG));
      return { root, dir, packetPath, wallet: w };
    }

    it("no --signer, no --strict: exit 0, but human AND JSON verdicts state UNPINNED explicitly", async function () {
      const { packetPath } = await makeSignedEvidencePacket(); // attacker's OWN key
      let c = cap();
      let code = await evidence.cmdEvidence(["verify-signed", packetPath], c.io);
      expect(code, c.err()).to.equal(0);
      expect(c.out()).to.contain("ACCEPTED: every requested check passed.");
      expect(c.out()).to.match(/UNPINNED/);
      expect(c.out()).to.match(UNPINNED_STATEMENT);

      c = cap();
      code = await evidence.cmdEvidence(["verify-signed", packetPath, "--json"], c.io);
      expect(code).to.equal(0);
      const j = JSON.parse(c.out());
      expect(j.pinning).to.equal("unpinned");
      expect(j.unpinnedNote).to.match(UNPINNED_STATEMENT);
      expect(j.verdict).to.equal("ACCEPTED");
    });

    it("--strict with no --signer: the distinct fail-closed exit 4, verdict UNPINNED", async function () {
      const { packetPath } = await makeSignedEvidencePacket();
      const c = cap();
      const code = await evidence.cmdEvidence(["verify-signed", packetPath, "--strict", "--json"], c.io);
      expect(code).to.equal(4);
      const j = JSON.parse(c.out());
      expect(j.verdict).to.equal("UNPINNED");
      expect(j.accepted).to.equal(false);
      expect(j.strict).to.equal(true);
      // Check 1 (the signature itself) still PASSED — only the pin is missing.
      expect(j.checks.signatureMatchesSigner).to.equal(true);

      const c2 = cap();
      expect(await evidence.cmdEvidence(["verify-signed", packetPath, "--strict"], c2.io)).to.equal(4);
      expect(c2.out()).to.contain("verify-signed:    UNPINNED");
      expect(c2.out()).to.match(/UNPINNED \(--strict, exit 4\)/);
    });

    it("pinned calls keep 0/3 verbatim under --strict: correct --signer exits 0; wrong --signer exits 3", async function () {
      const { packetPath, wallet } = await makeSignedEvidencePacket();
      let c = cap();
      let code = await evidence.cmdEvidence(
        ["verify-signed", packetPath, "--signer", wallet.address, "--strict", "--json"],
        c.io
      );
      expect(code, c.err()).to.equal(0);
      let j = JSON.parse(c.out());
      expect(j.verdict).to.equal("ACCEPTED");
      expect(j.pinning).to.equal("pinned");

      c = cap();
      code = await evidence.cmdEvidence(
        ["verify-signed", packetPath, "--signer", Wallet.createRandom().address, "--strict", "--json"],
        c.io
      );
      expect(code).to.equal(3);
      j = JSON.parse(c.out());
      expect(j.verdict).to.equal("REJECTED");
      expect(j.pinning).to.equal("pin_failed");
    });
  });
});

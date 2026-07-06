"use strict";

// test/verifier.proof-expect-root.test.js — T-75.4 acceptance: a BARE merkle-proof bundle must not
// print an unconditional "root matches: yes".
//
// WHAT THIS PROVES (mapped to the task's acceptance clauses)
//   (1) a self-contained (path, hash, siblings, root) bundle trivially "matches" — the leaf, the
//       siblings, AND the root all come from the SAME artifact. So the BARE verdict is WEAKENED to
//       internal consistency ONLY: the `root matches` line is qualified ("vs the artifact's OWN
//       embedded root — INTERNAL consistency only"), the verdict line reads WELL-FORMED (never the
//       strong "OK — the artifact verifies."), and the in-band PROOF_UNANCHORED_NOTE states it is
//       "NOT bound to any external/anchored root — pin the root out-of-band (--expect-root <0xroot>)
//       or verify against the on-chain record (vh verify-proof --rpc)". The producer CLI's
//       `vh verify-proof` with no provider prints the same weakened wording (and never ACCEPTED).
//   (2) the STRONG accept appears ONLY when an external root is independently supplied AND matched:
//       `--expect-root <0xroot>` with the right root gets the strong verdict; the wrong root is a
//       named `external_root_mismatch` REJECT (exit 3); a malformed pin / a pin on a non-proof
//       artifact / a pin in batch mode are named usage errors (exit 2). Tamper detection (forged
//       contentHash -> CHANGED) is preserved verbatim — this is a UX/overclaim fix, not a crypto
//       bypass.
//
// POSTURE: fully OFFLINE — no network, no key, no chain. All fixtures live in throwaway temp dirs.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const verifyvh = require("../verifier/verify-vh");
const merkle = require("../verifier/lib/merkle");
const { buildProof } = require("../cli/prove");
const { buildProofArtifact, writeProofArtifact, runVerifyProof, STATUS } = require("../cli/proof");

// io capture for verifyvh.run(argv, io) — the same harness pattern as verifier.strict-unpinned.test.js.
function cap() {
  const out = [];
  const err = [];
  return {
    io: { write: (s) => out.push(s), writeErr: (s) => err.push(s) },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

describe("T-75.4: bare merkle-proof bundle must not overclaim (internal consistency vs --expect-root)", function () {
  this.timeout(30000);

  let tmpDirs;
  beforeEach(function () {
    tmpDirs = [];
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-expectroot-"));
    tmpDirs.push(d);
    return d;
  }

  // A GENUINE proof bundle built with the verifier's OWN merkle lib (same fixture technique as
  // test/verifier.standalone.test.js): three path-bound leaves, sorted-pair fold, the proof for ONE
  // leaf. Returns { dir, proofPath, treeRoot }.
  function makeProofBundle() {
    const dir = mkTmp();
    const entries = [
      { relPath: "one.txt", bytes: Buffer.from("one") },
      { relPath: "two.txt", bytes: Buffer.from("two") },
      { relPath: "three.txt", bytes: Buffer.from("three") },
    ].map((e) => {
      const contentHash = merkle.hashBytes(e.bytes);
      return { relPath: e.relPath, contentHash, leaf: merkle.pathLeaf(e.relPath, contentHash) };
    });
    const target = entries[0];
    const sortedLeaves = entries.map((e) => e.leaf).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let layer = sortedLeaves.map((leaf) => ({ node: merkle.leafHash(leaf), isTarget: leaf === target.leaf }));
    const proof = [];
    while (layer.length > 1) {
      const next = [];
      for (let i = 0; i < layer.length; i += 2) {
        const left = layer[i];
        const right = i + 1 < layer.length ? layer[i + 1] : layer[i];
        if (left.isTarget) proof.push(right.node);
        else if (right.isTarget && right !== left) proof.push(left.node);
        next.push({ node: merkle.nodeHash(left.node, right.node), isTarget: left.isTarget || right.isTarget });
      }
      layer = next;
    }
    const treeRoot = layer[0].node;
    const bundle = {
      kind: "verifyhash.merkle-proof",
      root: treeRoot,
      leaf: target.leaf,
      contentHash: target.contentHash,
      relPath: target.relPath,
      proof,
    };
    const proofPath = path.join(dir, "membership.vhproof.json");
    fs.writeFileSync(proofPath, JSON.stringify(bundle, null, 2));
    return { dir, proofPath, treeRoot };
  }

  // ============================================================================================
  // (1) BARE bundle: the WEAKENED verdict — internal consistency ONLY, never a strong accept.
  // ============================================================================================
  describe("(1) bare bundle -> WELL-FORMED / internal consistency ONLY (never the strong accept)", function () {
    it("human output qualifies `root matches` and weakens the verdict (exit stays 0)", function () {
      const { proofPath } = makeProofBundle();
      const c = cap();
      const code = verifyvh.run([proofPath], c.io);
      expect(code).to.equal(verifyvh.EXIT.OK);
      const out = c.out();

      // NEVER an unqualified "root matches: yes" — the line names what the root was matched AGAINST.
      expect(out).to.not.match(/root matches:\s+yes\s*$/m);
      expect(out).to.include(
        "root matches:    yes (vs the artifact's OWN embedded root — INTERNAL consistency only, NOT an external/anchored root)"
      );

      // The verdict is the WEAK one, carrying the acceptance-mandated statement...
      expect(out).to.include("OK — WELL-FORMED (internal consistency ONLY), NOT an anchored-membership accept.");
      expect(out).to.include(verifyvh.PROOF_UNANCHORED_NOTE);
      expect(out).to.include("NOT bound to any external/anchored root");
      expect(out).to.include("pin the root out-of-band");
      // ...and NEVER the strong accept wording (reserved for an independently-supplied/anchored root).
      expect(out).to.not.include("OK — the artifact verifies.");
      expect(out).to.not.include("ACCEPTED against the INDEPENDENTLY-SUPPLIED root");
    });

    it("--json carries the machine-readable binding: rootBinding=internal + the unanchored note", function () {
      const { proofPath } = makeProofBundle();
      const c = cap();
      const code = verifyvh.run([proofPath, "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.OK);
      const r = JSON.parse(c.out());
      expect(r.accepted).to.equal(true);
      expect(r.rootMatches).to.equal(true); // internal consistency held...
      expect(r.proof.rootBinding).to.equal("internal"); // ...but the binding says what that MEANS
      expect(r.proof.expectedRoot).to.equal(null);
      expect(r.proof.externalRootMatches).to.equal(null);
      expect(r.proof.note).to.equal(verifyvh.PROOF_UNANCHORED_NOTE);
    });

    it("a batch PASS line for a bare proof bundle is labelled INTERNAL-consistency-only too", function () {
      const a = makeProofBundle();
      const b = makeProofBundle();
      const c = cap();
      const code = verifyvh.run([a.proofPath, b.proofPath], c.io);
      expect(code).to.equal(verifyvh.EXIT.OK);
      expect(c.out()).to.include("(proof bundle: INTERNAL consistency only — NOT bound to an external/anchored root)");
    });

    it("tamper detection is UNCHANGED: a forged contentHash still REJECTS (CHANGED, exit 3)", function () {
      const { proofPath } = makeProofBundle();
      const bundle = JSON.parse(fs.readFileSync(proofPath, "utf8"));
      bundle.contentHash = "0x" + "00".repeat(32);
      fs.writeFileSync(proofPath, JSON.stringify(bundle, null, 2));
      const c = cap();
      const code = verifyvh.run([proofPath], c.io);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      expect(c.out()).to.include("REJECTED (CHANGED)");
    });
  });

  // ============================================================================================
  // (2) --expect-root: the STRONG accept only against an INDEPENDENTLY-SUPPLIED, MATCHED root.
  // ============================================================================================
  describe("(2) --expect-root reserves the strong accept for an independently-supplied root", function () {
    it("the RIGHT pinned root -> the strong verdict (and the qualified external `root matches` line)", function () {
      const { proofPath, treeRoot } = makeProofBundle();
      const c = cap();
      const code = verifyvh.run([proofPath, "--expect-root", treeRoot], c.io);
      expect(code).to.equal(verifyvh.EXIT.OK);
      const out = c.out();
      expect(out).to.include("OK — the artifact verifies.");
      expect(out).to.include("ACCEPTED against the INDEPENDENTLY-SUPPLIED root");
      expect(out).to.include(`root matches:    yes (vs the INDEPENDENTLY-SUPPLIED --expect-root ${treeRoot.toLowerCase()})`);
      // The weakened bare-bundle wording must NOT appear on an externally-bound accept.
      expect(out).to.not.include("WELL-FORMED (internal consistency ONLY)");
      expect(out).to.not.include(verifyvh.PROOF_UNANCHORED_NOTE);
    });

    it("the pin is case-insensitive hex and --json records the external binding", function () {
      const { proofPath, treeRoot } = makeProofBundle();
      const shouted = "0x" + treeRoot.slice(2).toUpperCase();
      const c = cap();
      const code = verifyvh.run([proofPath, "--expect-root", shouted, "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.OK);
      const r = JSON.parse(c.out());
      expect(r.accepted).to.equal(true);
      expect(r.proof.rootBinding).to.equal("external");
      expect(r.proof.expectedRoot).to.equal(treeRoot.toLowerCase());
      expect(r.proof.externalRootMatches).to.equal(true);
      expect(r.proof.note).to.equal(verifyvh.PROOF_EXTERNAL_NOTE);
    });

    it("the WRONG pinned root -> named external_root_mismatch REJECT (exit 3)", function () {
      const { proofPath } = makeProofBundle();
      const wrong = "0x" + "ab".repeat(32);
      const c = cap();
      const code = verifyvh.run([proofPath, "--expect-root", wrong], c.io);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      const out = c.out();
      expect(out).to.include("REJECTED (external_root_mismatch)");
      expect(out).to.include("NOT to the independently-supplied --expect-root");
      expect(out).to.include("root matches:    NO (vs the INDEPENDENTLY-SUPPLIED --expect-root");
      // A wrong pin must never fall back to the weak accept.
      expect(out).to.not.include("WELL-FORMED");
    });

    it("the WRONG pinned root in --json: accepted=false, reason=external_root_mismatch, rootMatches=false", function () {
      const { proofPath } = makeProofBundle();
      const wrong = "0x" + "ab".repeat(32);
      const c = cap();
      const code = verifyvh.run([proofPath, "--expect-root", wrong, "--json"], c.io);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      const r = JSON.parse(c.out());
      expect(r.accepted).to.equal(false);
      expect(r.reason).to.equal("external_root_mismatch");
      expect(r.rootMatches).to.equal(false);
      expect(r.proof.externalRootMatches).to.equal(false);
      expect(r.proof.foldsToRoot).to.equal(true); // internally consistent — the pin is what failed
    });

    it("a FORGED bundle with the right pin still REJECTS as CHANGED (tamper dominates the pin)", function () {
      const { proofPath, treeRoot } = makeProofBundle();
      const bundle = JSON.parse(fs.readFileSync(proofPath, "utf8"));
      bundle.contentHash = "0x" + "11".repeat(32);
      fs.writeFileSync(proofPath, JSON.stringify(bundle, null, 2));
      const c = cap();
      const code = verifyvh.run([proofPath, "--expect-root", treeRoot], c.io);
      expect(code).to.equal(verifyvh.EXIT.REJECTED);
      expect(c.out()).to.include("REJECTED (CHANGED)");
    });
  });

  // ============================================================================================
  // (3) Fail-closed flag hygiene: named usage errors, never a silently-ignored pin.
  // ============================================================================================
  describe("(3) --expect-root usage hygiene (named errors, exit 2)", function () {
    it("a malformed --expect-root is a named usage error", function () {
      const { proofPath } = makeProofBundle();
      const c = cap();
      const code = verifyvh.run([proofPath, "--expect-root", "0x1234"], c.io);
      expect(code).to.equal(verifyvh.EXIT.USAGE);
      expect(c.err()).to.include("invalid --expect-root");
      expect(c.err()).to.include("32-byte hex Merkle root");
    });

    it("--expect-root on a NON-proof artifact is a named usage error", function () {
      // The verifier's own shipped demo evidence packet — a genuine non-proof artifact.
      const dir = mkTmp();
      const packetPath = path.join(dir, verifyvh.DEMO_PACKET_NAME);
      fs.writeFileSync(packetPath, JSON.stringify(verifyvh.DEMO_CONTAINER, null, 2));
      for (const [rel, content] of Object.entries(verifyvh.DEMO_FILES)) {
        fs.writeFileSync(path.join(dir, rel), content);
      }
      const c = cap();
      const code = verifyvh.run([packetPath, "--expect-root", "0x" + "ab".repeat(32)], c.io);
      expect(code).to.equal(verifyvh.EXIT.USAGE);
      expect(c.err()).to.include("--expect-root applies only to a merkle-proof bundle");
    });

    it("--expect-root does not compose with batch/manifest (it pins ONE bundle's root)", function () {
      const a = makeProofBundle();
      const b = makeProofBundle();
      const c = cap();
      const code = verifyvh.run([a.proofPath, b.proofPath, "--expect-root", a.treeRoot], c.io);
      expect(code).to.equal(verifyvh.EXIT.USAGE);
      expect(c.err()).to.include("--expect-root pins ONE proof bundle's root");
    });

    it("usage() documents the contract (the flag + the weakened bare verdict + external_root_mismatch)", function () {
      const u = verifyvh.usage();
      expect(u).to.include("--expect-root <0xroot>");
      expect(u).to.include("WELL-FORMED (internally consistent) ONLY");
      expect(u).to.include("external_root_mismatch");
    });
  });

  // ============================================================================================
  // (4) DISK == BYTES parity: expectRoot threads through the pure engine identically.
  // ============================================================================================
  describe("(4) the bytes path (verifyArtifactFromBytes) mirrors the disk path with expectRoot", function () {
    it("right pin, wrong pin, and bare all DEEP-EQUAL across the two paths", function () {
      const { proofPath, treeRoot } = makeProofBundle();
      const artifactText = fs.readFileSync(proofPath, "utf8");
      for (const expectRoot of [undefined, treeRoot, "0x" + "cd".repeat(32)]) {
        const disk = verifyvh.verifyArtifact({ artifact: proofPath, expectRoot });
        const bytes = verifyvh.verifyArtifactFromBytes({
          artifactText,
          files: {},
          expectRoot,
          artifactName: proofPath,
        });
        expect(bytes.error).to.equal(null);
        expect(bytes.code).to.equal(disk.code);
        expect(bytes.result).to.deep.equal(disk.result);
      }
    });

    it("a malformed expectRoot on the bytes path is a NAMED UsageError return (never a throw)", function () {
      const { proofPath } = makeProofBundle();
      const artifactText = fs.readFileSync(proofPath, "utf8");
      const out = verifyvh.verifyArtifactFromBytes({ artifactText, files: {}, expectRoot: "nope" });
      expect(out.result).to.equal(null);
      expect(out.code).to.equal(verifyvh.EXIT.USAGE);
      expect(out.error.name).to.equal("UsageError");
      expect(out.error.message).to.include("--expect-root");
    });
  });

  // ============================================================================================
  // (5) The producer CLI (`vh verify-proof`) prints the SAME weakened wording with no provider.
  // ============================================================================================
  describe("(5) vh verify-proof with NO provider states internal consistency only", function () {
    function makeRepo() {
      const dir = mkTmp();
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "index.js"), "module.exports = 42;\n");
      fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
      return dir;
    }

    it("offline-only run: weakened wording present, ACCEPTED absent", async function () {
      const repo = makeRepo();
      const built = buildProof({ file: "src/index.js", rootDir: repo });
      const outDir = mkTmp();
      const p = path.join(outDir, "proof.json");
      writeProofArtifact(buildProofArtifact(built), p);

      let log = "";
      const res = await runVerifyProof({ artifactPath: p, log: (s) => (log += s) });
      expect(res.offlineOk).to.equal(true);
      expect(res.status).to.not.equal(STATUS.ACCEPTED);
      // The acceptance-mandated weakened statement, on the producer CLI path too.
      expect(log).to.include("This proof is well-formed");
      expect(log).to.include("NOT bound to any external/anchored root");
      expect(log).to.include("pin the root");
      expect(log).to.not.include("result:         ACCEPTED");
      // The machine-readable note says the same thing.
      expect(res.note).to.include("NOT bound to any external/anchored root");
    });
  });
});

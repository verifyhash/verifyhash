const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// T-9.3 docs-rot guard for portable proofs (docs/PROOFS.md + the README CLI block)
// and the T-9.1 safe-receipt change (docs/RECEIPTS.md).
//
// Pure (no chain, no fixtures): asserts the prose keeps documenting what the code in cli/proof.js /
// cli/prove.js / cli/claim.js actually does, so docs/PROOFS.md, the README, and docs/RECEIPTS.md can't
// silently drift from the implementation. Load-bearing strings are cross-checked against the real
// exports/wording (the kind discriminator, the supported schema version, the trust caveat, the schema
// fields, the verification verdicts, and the receipt secret-salt/opt-in posture).
// ---------------------------------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

const {
  PROOF_KIND,
  PROOF_SCHEMA_VERSION,
  SUPPORTED_PROOF_SCHEMA_VERSIONS,
  STATUS,
  TRUST_CAVEAT,
} = require("../cli/proof");

describe("T-9.3 docs: portable proofs (docs/PROOFS.md) + README CLI block", function () {
  const proofs = read("docs/PROOFS.md");
  const proofsLower = proofs.toLowerCase();
  const readme = read("README.md");
  const readmeLower = readme.toLowerCase();

  it("the proof module still exports the symbols this guard pins against (tripwire)", function () {
    expect(PROOF_KIND, "PROOF_KIND export").to.be.a("string");
    expect(PROOF_SCHEMA_VERSION, "PROOF_SCHEMA_VERSION export").to.be.a("number");
    expect(SUPPORTED_PROOF_SCHEMA_VERSIONS, "SUPPORTED_PROOF_SCHEMA_VERSIONS export").to.be.an("array");
    expect(TRUST_CAVEAT, "TRUST_CAVEAT export").to.be.a("string");
    expect(STATUS, "STATUS export").to.be.an("object");
  });

  it("docs/PROOFS.md exists and is non-trivial", function () {
    expect(proofs.length).to.be.greaterThan(2000);
  });

  describe("schema: pinned to the code", function () {
    it("names the proof kind discriminator exactly as cli/proof.js defines it", function () {
      expect(proofs).to.include(PROOF_KIND);
    });

    it("documents the schema version this build writes and every version it reads", function () {
      expect(proofs).to.include("schemaVersion");
      expect(proofs).to.include(String(PROOF_SCHEMA_VERSION));
      for (const v of SUPPORTED_PROOF_SCHEMA_VERSIONS) {
        expect(proofs).to.include(String(v));
      }
    });

    it("documents EVERY artifact field", function () {
      // The full schema cli/proof.js validates: required + optional.
      for (const f of [
        "kind",
        "schemaVersion",
        "root",
        "leaf",
        "contentHash",
        "relPath",
        "proof",
        "contractAddress",
        "chainId",
      ]) {
        expect(proofs, `field ${f}`).to.include(f);
      }
    });

    it("states every field is UNTRUSTED transport and that verification RE-DERIVES", function () {
      expect(proofsLower).to.include("untrusted");
      expect(proofsLower).to.match(/transport/);
      expect(proofsLower).to.match(/re-?derive/);
      expect(proofsLower).to.match(/re-?fold/);
    });
  });

  describe("verification steps", function () {
    it("documents the offline fold and the on-chain check as the two stages", function () {
      expect(proofsLower).to.match(/offline (fold|recompute)/);
      expect(proofsLower).to.match(/on-chain/);
      expect(proofsLower).to.match(/isanchored/);
      expect(proofs).to.include("verifyLeaf");
    });

    it("documents all three verdicts that cli/proof.js can return", function () {
      // STATUS = { ACCEPTED, REJECTED, NOT_ANCHORED }
      expect(proofs).to.include(STATUS.ACCEPTED);
      expect(proofs).to.include(STATUS.REJECTED);
      // NOT_ANCHORED is rendered "NOT ANCHORED" in the human verdict.
      expect(proofs).to.match(/NOT[ _]ANCHORED/);
    });

    it("states ACCEPTED requires BOTH the offline fold AND the on-chain check", function () {
      expect(proofsLower).to.match(/offline fold[\s\S]{0,80}on-chain|both[\s\S]{0,60}on-chain/);
      expect(proofsLower).to.include("accepted");
    });
  });

  describe("trust posture: set-membership only, reusing TRUST-BOUNDARIES wording", function () {
    it("carries the load-bearing set-membership phrase the CLI prints", function () {
      // We don't pin the whole multi-line caveat verbatim (the doc paraphrases around it), but the
      // doc MUST carry the core phrase the code's TRUST_CAVEAT leads with, so they can't drift.
      expect(proofs).to.include("SET-MEMBERSHIP");
      // The contract's verifyLeaf is the boundary being drawn.
      expect(proofs).to.include("verifyLeaf");
    });

    it("states it does NOT prove authorship or the uri", function () {
      expect(proofsLower).to.match(/not[\s\S]{0,40}authorship/);
      expect(proofsLower).to.include("uri");
      expect(proofs).to.include("authorBound");
    });

    it("cross-links the consistent caveats in TRUST-BOUNDARIES / RECEIPTS / MERKLE-LEAVES", function () {
      expect(proofs).to.include("TRUST-BOUNDARIES.md");
      expect(proofs).to.include("RECEIPTS.md");
      expect(proofs).to.include("MERKLE-LEAVES.md");
    });
  });

  it("includes a worked prove -> hand over -> verify-proof example with a concrete JSON artifact", function () {
    expect(proofs).to.include("```json");
    expect(proofs).to.include(PROOF_KIND); // inside the worked example too
    expect(proofs).to.include("vh prove");
    expect(proofs).to.include("vh verify-proof");
    // The three-step framing the acceptance asks for.
    expect(proofsLower).to.match(/prove[\s\S]{0,40}hand[\s\S]{0,40}verify-proof|hand over/);
  });

  describe("README CLI block lists vh prove --out and vh verify-proof", function () {
    const block = readme.split("```").find((b) => b.includes("vh hash") && b.includes("vh verify"));

    it("has the CLI fenced block", function () {
      expect(block, "CLI fenced block").to.be.a("string");
    });

    it("lists vh verify-proof and the vh prove --out flag", function () {
      const proveLine = block.split("\n").find((l) => l.includes("vh prove"));
      const vpLine = block.split("\n").find((l) => l.includes("vh verify-proof"));
      expect(proveLine, "vh prove line").to.be.a("string");
      expect(vpLine, "vh verify-proof line").to.be.a("string");
      expect(proveLine).to.include("--out");
    });

    it("states the read-only, no-key, no-repo property for both in that block", function () {
      const proveLine = block.split("\n").find((l) => l.includes("vh prove")).toLowerCase();
      const vpLine = block.split("\n").find((l) => l.includes("vh verify-proof")).toLowerCase();
      // verify-proof: read-only, no key, no repo needed.
      expect(vpLine).to.match(/read-only/);
      expect(vpLine).to.match(/no key|no\s*key/);
      expect(vpLine).to.match(/no repo/);
      // the prove --out line advertises the same portability property (no repo needed to verify).
      expect(proveLine).to.match(/no repo|no key|read-only/);
    });
  });

  describe("README portable-proofs prose + Docs list cross-link to docs/PROOFS.md", function () {
    it("has a portable proofs section naming both commands", function () {
      expect(readmeLower).to.include("portable proof");
      expect(readme).to.include("vh prove");
      expect(readme).to.include("vh verify-proof");
    });

    it("states verify-proof needs no key, no repo, no working tree", function () {
      expect(readmeLower).to.match(/no key, no repo, and no working tree|no key.{0,30}no repo/);
    });

    it("links docs/PROOFS.md from the Docs list", function () {
      expect(readme).to.include("docs/PROOFS.md");
    });
  });
});

describe("T-9.3 docs: T-9.1 safe-receipt change reflected in docs/RECEIPTS.md + README", function () {
  const receipts = read("docs/RECEIPTS.md");
  const receiptsLower = receipts.toLowerCase();
  const readme = read("README.md");
  const readmeLower = readme.toLowerCase();

  it("docs/RECEIPTS.md states the claim receipt holds a SECRET salt", function () {
    expect(receipts).to.include("salt");
    expect(receiptsLower).to.match(/secret[\s\S]{0,80}salt|salt[\s\S]{0,80}secret/);
  });

  it("docs/RECEIPTS.md states the destination is OPT-IN and never silently written to your repo/cwd", function () {
    // The T-9.1 safe-path posture: opt into where it goes; it is never dropped silently.
    expect(receiptsLower).to.match(/opt into|opt-in/);
    expect(receiptsLower).to.match(/never silently|never written somewhere you can't find|never[\s\S]{0,40}silently/);
  });

  it("docs/RECEIPTS.md states the exact path is always named on write", function () {
    expect(receipts).to.include("receipt written:");
    expect(receiptsLower).to.match(/exact[\s\S]{0,40}(path|file)/);
  });

  it("docs/RECEIPTS.md documents the --receipt / --receipt-dir destinations", function () {
    expect(receipts).to.include("--receipt");
    expect(receipts).to.include("--receipt-dir");
  });

  it("docs/RECEIPTS.md states vh claim writes NOTHING without an explicit destination", function () {
    // The T-9.1 change: the one-shot runClaim no longer drops a cwd receipt by default.
    expect(receiptsLower).to.match(/writes\s+\**nothing\**|writes nothing/);
  });

  it("docs/RECEIPTS.md reuses the TRUST-BOUNDARIES untrusted-convenience wording", function () {
    expect(receiptsLower).to.include("untrusted");
    expect(receipts).to.include("TRUST-BOUNDARIES.md");
  });

  it("README's resumable-claims section reflects the same secret/opt-in posture", function () {
    expect(readmeLower).to.include("secret");
    expect(readme).to.include("salt");
    expect(readme).to.include("receipt written:");
    expect(readmeLower).to.match(/never writes it silently|opt into|never silently/);
  });
});

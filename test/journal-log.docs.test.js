"use strict";

// ---------------------------------------------------------------------------
// T-63.3 docs-rot guard for the TRANSPARENCY-LOG surface (EPIC-63).
//
// Pure (no chain, no CLI run): asserts docs/INTEGRITY-JOURNAL.md documents the
// four `vh journal` transparency-log commands the way the code actually
// behaves, carries the load-bearing honesty boundary VERBATIM, and that
// README.md + docs/SDK.md make the section discoverable — so the buyer-/
// auditor-facing prose can never silently drift from cli/journal-cli.js +
// cli/journal-log.js.
//
// The acceptance this pins (T-63.3):
//   * the doc gains a "Transparency-log proofs" section naming ALL FOUR
//     commands — tree-head / prove-inclusion / prove-consistency /
//     check-proof — plus the proof-artifact schemas and the 0/3 contract;
//   * it explains the RFC-6962 / Certificate-Transparency lineage and why the
//     ordered log tree is intentionally DIFFERENT from the sorted file-SET
//     tree in cli/hash.js;
//   * it walks a copy-pasteable worked example end-to-end (append 3 →
//     tree-head → prove-inclusion --seq 1 → check-proof → append 2 more →
//     prove-consistency --from 3 → check-proof);
//   * it states what inclusion AND consistency prove, and carries the
//     self-asserted-head / not-a-timestamp honesty sentence VERBATIM
//     (byte-matched against the live SELF_ASSERTED_HEAD_NOTE export);
//   * it NEVER claims "unaltered since date T" without the P-3 qualification;
//   * README.md + docs/SDK.md point at the section;
//   * NO P-3 / P-9 human step in STRATEGY.md was deleted or relaxed (signing
//     the 32-byte head is the P-3 COLLAPSE of "sign the whole log", NOT a new
//     or weakened gate).
//
// The guard imports the live CLI + core modules it pins against, so a removed
// command/constant fails loudly — an otherwise-hollow docs guard.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

// The live modules the doc describes (a removed surface trips the guard).
const journalCli = require("../cli/journal-cli");
const journalLog = require("../cli/journal-log");

const SECTION_HEADING = "## Transparency-log proofs (publish a tree head; auditors verify offline)";
const COMMANDS = ["tree-head", "prove-inclusion", "prove-consistency", "check-proof"];

// The transparency-log section ONLY (heading → the next top-level "## " heading),
// so an assertion cannot be satisfied by prose that lives in a later section.
const txLogSection = (doc) => {
  const start = doc.indexOf(SECTION_HEADING);
  const end = doc.indexOf("\n## ", start + SECTION_HEADING.length);
  return doc.slice(start, end === -1 ? doc.length : end);
};

describe("T-63.3 docs: transparency-log documented honestly + discoverable", function () {
  let doc;

  before(function () {
    doc = read("docs/INTEGRITY-JOURNAL.md");
  });

  // -------------------------------------------------------------------------
  // (0) The live surface this guard pins against still exists.
  // -------------------------------------------------------------------------
  describe("the live modules still export the surface the doc describes", function () {
    it("cli/journal-cli.js exports the four command runners + the honesty-note constants", function () {
      expect(journalCli).to.have.property("runJournalTreeHead").that.is.a("function");
      expect(journalCli).to.have.property("runJournalProveInclusion").that.is.a("function");
      expect(journalCli).to.have.property("runJournalProveConsistency").that.is.a("function");
      expect(journalCli).to.have.property("runJournalCheckProof").that.is.a("function");
      expect(journalCli).to.have.property("SELF_ASSERTED_HEAD_NOTE").that.is.a("string");
      expect(journalCli).to.have.property("CHECK_PROOF_NOTE").that.is.a("string");
      expect(journalCli).to.have.property("JOURNAL_INCLUSION_PROOF_KIND", "vh-journal-inclusion");
      expect(journalCli).to.have.property("JOURNAL_CONSISTENCY_PROOF_KIND", "vh-journal-consistency");
    });

    it("cli/journal-log.js exports the pure RFC-6962 core the commands ride on", function () {
      for (const fn of ["treeHead", "inclusionProof", "verifyInclusion", "consistencyProof", "verifyConsistency"]) {
        expect(journalLog, `journal-log core must export ${fn}`).to.have.property(fn).that.is.a("function");
      }
    });
  });

  // -------------------------------------------------------------------------
  // (a) The section exists and names ALL FOUR commands.
  // -------------------------------------------------------------------------
  describe("docs/INTEGRITY-JOURNAL.md — the transparency-log section", function () {
    it("carries the section heading", function () {
      expect(doc, "the transparency-log section heading is missing").to.contain(SECTION_HEADING);
    });

    it("names ALL FOUR commands: tree-head / prove-inclusion / prove-consistency / check-proof", function () {
      for (const cmd of COMMANDS) {
        expect(doc, `doc must name \`vh journal ${cmd}\``).to.match(
          new RegExp(`vh journal ${cmd.replace(/-/g, "\\-")}`)
        );
      }
    });

    it("explains the RFC-6962 / Certificate-Transparency lineage (and names Rekor)", function () {
      expect(doc).to.match(/RFC[- ]?6962/);
      expect(doc).to.match(/Certificate[- ]Transparency/i);
      expect(doc).to.match(/Rekor/);
    });

    it("explains WHY the ordered log tree differs from the sorted file-SET tree in cli/hash.js", function () {
      const section = doc.slice(doc.indexOf(SECTION_HEADING));
      expect(section, "must name cli/hash.js as the intentionally-different tree").to.match(/cli\/hash\.js/);
      expect(section.toLowerCase(), "must say the seal tree is sorted / order-independent").to.match(/sorted/);
      expect(section.toLowerCase(), "must say the log tree is position-preserving").to.match(/position-preserving/);
      expect(section.toLowerCase(), "must state order is meaning for a journal").to.match(/order is meaning/);
      // The RFC-6962 domain separation is documented (leaf 0x00 / node 0x01).
      expect(section).to.match(/0x00/);
      expect(section).to.match(/0x01/);
    });

    it("documents BOTH proof-artifact schemas with their exact `kind` strings + fields", function () {
      // Byte-match the kinds against the live CLI constants (a renamed kind fails here).
      expect(doc).to.contain(journalCli.JOURNAL_INCLUSION_PROOF_KIND);
      expect(doc).to.contain(journalCli.JOURNAL_CONSISTENCY_PROOF_KIND);
      // Inclusion-artifact fields.
      for (const field of ["leaf", "seq", "size", "root", "path"]) {
        expect(doc, `inclusion schema field \`${field}\` missing`).to.match(new RegExp(`"${field}"`));
      }
      // Consistency-artifact fields.
      for (const field of ["first", "second", "proof"]) {
        expect(doc, `consistency schema field \`${field}\` missing`).to.match(new RegExp(`"${field}"`));
      }
    });

    it("documents the shared 0/3 exit contract for the four commands (fail closed)", function () {
      const section = doc.slice(doc.indexOf(SECTION_HEADING));
      expect(section).to.match(/ACCEPTED/);
      expect(section).to.match(/REJECTED/);
      expect(section.toLowerCase()).to.match(/exit/);
      expect(section, "the 0/3 contract must be stated").to.match(/`0`|exit 0/);
      expect(section, "the 0/3 contract must be stated").to.match(/`3`|exit 3/);
      expect(section.toLowerCase(), "fail-closed posture must be stated").to.match(/fail closed|never a silent pass/);
    });

    it("states check-proof is the OFFLINE auditor path — proof artifact ONLY, no journal / key / network", function () {
      const section = doc.slice(doc.indexOf(SECTION_HEADING));
      expect(section.toLowerCase()).to.match(/offline/);
      expect(section.toLowerCase()).to.match(/auditor/);
      expect(section.toLowerCase(), "must say the auditor never needs the journal").to.match(
        /never the journal|no journal|without ever holding your log|without your log/
      );
      expect(section.toLowerCase()).to.match(/no key|never a key/);
      expect(section.toLowerCase()).to.match(/no network|never a socket/);
    });

    // ---- (VerifierIndependence rework) -----------------------------------
    // The word "OFFLINE" is sold hardest for check-proof, so the section must
    // NOT let a CT/Rekor-literate reader infer "checkable with a light,
    // independent client." check-proof rides cli/journal-log.js, which
    // `require`s ethers (verified live below) — so the section must disclose,
    // IN the transparency-log section itself, that these commands run in the
    // PRODUCER package and that "OFFLINE" here means no-network/no-log, NOT
    // "no producer stack". Guards the exact honesty caveat from rotting out.
    it("DISCLOSES that check-proof/tree-head/prove-* run in the PRODUCER package — OFFLINE ≠ no producer stack", function () {
      const section = txLogSection(doc);
      expect(section.toLowerCase(), "the section must name the producer package as the runtime for these commands")
        .to.match(/producer package/);
      expect(section, "the section must name ethers as the pulled-in producer dependency").to.match(/ethers/);
      expect(
        section,
        "the section must say the proof artifacts are NOT yet checkable with the standalone zero-dep verifier/ bundle"
      ).to.match(/not yet/i);
      expect(section, "the section must contrast against the standalone verifier/ bundle a seal enjoys").to.match(
        /verifier\//
      );
      expect(section.toLowerCase(), "the section must cross-reference the Independence scope caveat")
        .to.match(/independence scope/);
    });

    it("the check-proof producer-package caveat is grounded in reality: cli/journal-log.js really requires ethers", function () {
      // If the code ever stops pulling the producer stack, this doc caveat can honestly relax — fail loudly then.
      const src = read("cli/journal-log.js");
      expect(src, "the caveat claims journal-log.js requires ethers; keep that true or update the doc").to.match(
        /require\(["']ethers["']\)/
      );
    });
  });

  // -------------------------------------------------------------------------
  // (b) The worked example is present, end-to-end, in the documented order.
  // -------------------------------------------------------------------------
  describe("the worked example (copy-pasteable, end-to-end)", function () {
    it("walks append ×3 → tree-head → prove-inclusion --seq 1 → check-proof → append ×2 → prove-consistency --from 3 → check-proof, IN ORDER", function () {
      const section = doc.slice(doc.indexOf(SECTION_HEADING));
      const treeHeadAt = section.indexOf("vh journal tree-head journal.jsonl");
      const proveInclAt = section.indexOf("vh journal prove-inclusion journal.jsonl --seq 1");
      const checkInclAt = section.indexOf("vh journal check-proof seq1.inclusion.json");
      const proveConsAt = section.indexOf("vh journal prove-consistency journal.jsonl --from 3");
      const checkConsAt = section.indexOf("vh journal check-proof 3-to-5.consistency.json");
      expect(treeHeadAt, "worked example: tree-head step missing").to.be.greaterThan(-1);
      expect(proveInclAt, "worked example: prove-inclusion --seq 1 step missing").to.be.greaterThan(-1);
      expect(checkInclAt, "worked example: offline check-proof of the inclusion proof missing").to.be.greaterThan(-1);
      expect(proveConsAt, "worked example: prove-consistency --from 3 step missing").to.be.greaterThan(-1);
      expect(checkConsAt, "worked example: offline check-proof of the consistency proof missing").to.be.greaterThan(-1);
      expect(treeHeadAt).to.be.lessThan(proveInclAt);
      expect(proveInclAt).to.be.lessThan(checkInclAt);
      expect(checkInclAt).to.be.lessThan(proveConsAt);
      expect(proveConsAt).to.be.lessThan(checkConsAt);
      // Three appends before the first head, two more before the consistency proof (3 → 5).
      const appends = section.split("vh journal append").length - 1;
      expect(appends, "worked example must append 3 + 2 = 5 observations").to.be.at.least(5);
      expect(section, "the example must show the log growing 3 → 5").to.match(/3\s*→\s*5/);
    });
  });

  // -------------------------------------------------------------------------
  // (c) The honesty boundary — VERBATIM, and never an unqualified date-T claim.
  // -------------------------------------------------------------------------
  describe("the honesty boundary", function () {
    it("describes what INCLUSION proves AND what CONSISTENCY proves", function () {
      const section = doc.slice(doc.indexOf(SECTION_HEADING));
      // Inclusion: an observation is committed at a position under a given head.
      expect(section, "inclusion meaning missing").to.match(
        /\*\*Inclusion\*\* proves an observation is \*\*committed at a position \(`seq`\) under a given head\*\*/
      );
      // Consistency: the log is append-only between two heads.
      expect(section, "consistency meaning missing").to.match(
        /\*\*Consistency\*\* proves the log is \*\*append-only between two heads\*\*/
      );
    });

    it("carries the SELF-ASSERTED-head / not-a-timestamp sentence VERBATIM (byte-matched against the code)", function () {
      // The single source of truth is the live CLI constant every tree-head/prove-* output prints.
      expect(doc, "the doc must carry SELF_ASSERTED_HEAD_NOTE verbatim").to.contain(
        journalCli.SELF_ASSERTED_HEAD_NOTE
      );
      // Belt-and-braces: the constant itself still says what the doc relies on it saying.
      expect(journalCli.SELF_ASSERTED_HEAD_NOTE).to.match(/SELF-ASSERTED/);
      expect(journalCli.SELF_ASSERTED_HEAD_NOTE).to.match(/does NOT by itself prove/);
      expect(journalCli.SELF_ASSERTED_HEAD_NOTE).to.match(/P-3/);
    });

    it("carries the check-proof ACCEPT meaning (compare the embedded head against one you trust) VERBATIM", function () {
      expect(doc, "the doc must carry CHECK_PROOF_NOTE verbatim").to.contain(journalCli.CHECK_PROOF_NOTE);
    });

    it("NEVER claims \"unaltered since date T\" without the P-3 qualification (whole doc)", function () {
      const phrase = "unaltered since date T";
      let idx = doc.indexOf(phrase);
      expect(idx, "the doc should discuss the 'unaltered since date T' boundary").to.be.greaterThan(-1);
      while (idx !== -1) {
        const window = doc.slice(Math.max(0, idx - 400), Math.min(doc.length, idx + phrase.length + 400));
        expect(
          window,
          `an "unaltered since date T" claim near index ${idx} is not qualified with P-3`
        ).to.match(/P-3/);
        idx = doc.indexOf(phrase, idx + 1);
      }
    });

    it("states signing the head is the P-3 COLLAPSE (sign 32 bytes, not the whole log) — NO new gate, NO relaxed gate", function () {
      const section = doc.slice(doc.indexOf(SECTION_HEADING));
      expect(section).to.match(/sign the whole log/);
      expect(section).to.match(/sign 32 bytes/);
      expect(section).to.match(/NO new gate and NO relaxed gate/);
      expect(section, "P-3's and P-9's human steps must be declared unchanged").to.match(
        /P-3's and P-9's[\s\S]{0,80}human-owned steps are \*\*unchanged\*\*/
      );
    });
  });

  // -------------------------------------------------------------------------
  // (d) Discoverability: README.md + docs/SDK.md point at the section.
  // -------------------------------------------------------------------------
  describe("README.md + docs/SDK.md point at the transparency-log section", function () {
    it("README.md names the commands, the offline-auditor posture, and the section", function () {
      const readme = read("README.md");
      expect(readme).to.match(/vh journal tree-head/);
      expect(readme).to.match(/prove-inclusion/);
      expect(readme).to.match(/prove-consistency/);
      expect(readme).to.match(/check-proof/);
      expect(readme, "README must link the doc + name the section").to.contain(
        'Transparency-log proofs (publish a tree head'
      );
      expect(readme).to.contain("docs/INTEGRITY-JOURNAL.md");
      // The pointer itself stays honest: self-asserted head until P-3 signs it.
      const at = readme.indexOf("vh journal tree-head");
      const near = readme.slice(Math.max(0, at - 600), at + 900);
      expect(near.toLowerCase()).to.match(/self-asserted/);
      expect(near).to.match(/P-3/);
      // ...and honest about INDEPENDENCE: "offline" here is via the producer package, not the standalone verifier/.
      expect(near.toLowerCase(), "README pointer must carry the producer-package independence caveat")
        .to.match(/producer package/);
    });

    it("docs/SDK.md names the commands, the offline-auditor posture, and the section", function () {
      const sdk = read("docs/SDK.md");
      expect(sdk).to.match(/vh journal tree-head/);
      expect(sdk).to.match(/prove-inclusion/);
      expect(sdk).to.match(/prove-consistency/);
      expect(sdk).to.match(/check-proof/);
      expect(sdk, "SDK doc must link the doc + name the section").to.contain(
        'Transparency-log proofs (publish a tree head'
      );
      expect(sdk).to.contain("INTEGRITY-JOURNAL.md");
      const at = sdk.indexOf("vh journal tree-head");
      const near = sdk.slice(Math.max(0, at - 600), at + 900);
      expect(near.toLowerCase()).to.match(/self-asserted/);
      expect(near).to.match(/P-3/);
      expect(near.toLowerCase(), "SDK pointer must carry the producer-package independence caveat")
        .to.match(/producer package/);
    });
  });

  // -------------------------------------------------------------------------
  // (e) NO P-3 / P-9 human step was deleted or relaxed in STRATEGY.md.
  // -------------------------------------------------------------------------
  describe("STRATEGY.md — P-3 + P-9 human steps intact (no gate deleted or relaxed)", function () {
    let strat;

    before(function () {
      strat = read("STRATEGY.md");
    });

    it("P-3's human handoff steps are still present, unchanged", function () {
      expect(strat, "P-3 block missing").to.match(/P-3 \(2026-06-23\)/);
      expect(strat).to.contain("(1) pick A/B/C");
      expect(strat).to.contain("PROVISION a real signing key OUTSIDE the");
      expect(strat).to.match(/run `vh dataset sign/);
    });

    it("P-9 still carries its THREE human steps, in order, unchanged", function () {
      const start = strat.indexOf("P-9 (2026-07-01) — EMBEDDABLE SDK distribution");
      expect(start, "P-9 block not found").to.be.greaterThan(-1);
      const p9Block = strat.slice(start);
      const step1 = p9Block.indexOf("1. **Decide whether/how to PUBLISH.**");
      const step2 = p9Block.indexOf("2. **Pick the embed/usage PRICE");
      const step3 = p9Block.indexOf("3. **Offer + support the SDK to embedders.**");
      expect(step1, "P-9 step 1 (PUBLISH) missing").to.be.greaterThan(-1);
      expect(step2, "P-9 step 2 (PRICE) missing").to.be.greaterThan(-1);
      expect(step3, "P-9 step 3 (Offer + support) missing").to.be.greaterThan(-1);
      expect(step1).to.be.lessThan(step2);
      expect(step2).to.be.lessThan(step3);
    });
  });
});

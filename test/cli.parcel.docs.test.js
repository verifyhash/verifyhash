"use strict";

// ---------------------------------------------------------------------------
// T-18.3 docs-rot guard for ProofParcel (docs/PROOFPARCEL.md + README.md).
//
// Pure (no chain, no fixtures): asserts the buyer-facing prose documents ProofParcel the way the code
// actually behaves, so it can't silently drift from cli/parcel.js. Load-bearing properties:
//   * docs/PROOFPARCEL.md documents the buyer (B2B proof-of-delivery), the command table
//     (build/verify/attest/verify-attest with the offline/no-key/no-network/CI-gateable exit 0/3
//     property), a worked sender -> [signs, P-3] -> recipient verify-attest example,
//   * CRITICALLY documents the SAME honest trust posture as DataLedger: binds the file SET + signable,
//     but NOT a trusted delivery TIMESTAMP (rides P-3), and the parcel metadata is UNTRUSTED self-asserted,
//   * the signed-container kind it names matches the code's verifyhash.parcel-attestation-signed,
//   * README gains a `### Data-delivery receipts (ProofParcel)` section listing all four commands,
//   * the caveats reuse the existing in-band TRUST wording so they stay consistent (no drift).
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

// Importing parcel.js pins the in-band caveat wording this guard reuses AND fails loudly if the module
// (or its attest/verify-attest surface + caveats) is ever removed — the guard would otherwise be hollow.
const parcel = require("../cli/parcel");

describe("T-18.3 docs: ProofParcel documented (docs/PROOFPARCEL.md + README)", function () {
  let doc, docLower, readme;

  before(function () {
    doc = read("docs/PROOFPARCEL.md");
    docLower = doc.toLowerCase();
    readme = read("README.md");
  });

  it("parcel.js still exports the attest/verify-attest surface + caveat wording this guard pins against", function () {
    expect(parcel.runParcelAttest, "runParcelAttest export").to.be.a("function");
    expect(parcel.runParcelVerifyAttest, "runParcelVerifyAttest export").to.be.a("function");
    expect(parcel.TRUST_NOTE, "TRUST_NOTE export").to.be.a("string");
    expect(parcel.PARCEL_TRUST_NOTE, "PARCEL_TRUST_NOTE export").to.be.a("string");
    expect(parcel.PARCEL_ATTESTATION_TRUST_NOTE, "PARCEL_ATTESTATION_TRUST_NOTE export").to.be.a("string");
    expect(parcel.SIGNED_PARCEL_ATTESTATION_KIND, "SIGNED_PARCEL_ATTESTATION_KIND export").to.be.a("string");
    expect(parcel.SIGNED_PARCEL_ATTESTATION_SCHEMES, "SIGNED_PARCEL_ATTESTATION_SCHEMES export").to.be.an("array");
    // The exact kind + scheme strings the docs must name verbatim (so prose can't drift from the wire).
    expect(parcel.SIGNED_PARCEL_ATTESTATION_KIND).to.equal("verifyhash.parcel-attestation-signed");
    expect(parcel.SIGNED_PARCEL_ATTESTATION_SCHEMES).to.include("eip191-personal-sign");
  });

  describe("docs/PROOFPARCEL.md", function () {
    it("documents the buyer: B2B proof-of-delivery, delivery dispute", function () {
      expect(docLower).to.match(/proof-of-delivery|proof of delivery/);
      expect(docLower).to.match(/b2b/);
      expect(docLower).to.match(/dispute/);
      // The two expensive failure modes that motivate paying for it.
      expect(docLower).to.match(/never sent|altered/);
    });

    it("has a command table listing build/verify/attest/verify-attest", function () {
      const rows = doc.split("\n").filter((l) => l.trim().startsWith("|"));
      const joined = rows.join("\n");
      expect(joined).to.include("vh parcel build");
      expect(joined).to.include("vh parcel verify");
      expect(joined).to.include("vh parcel attest");
      expect(joined).to.include("vh parcel verify-attest");
    });

    it("advertises offline / no key / no network / CI-gateable exit 0/3 for the verify gates", function () {
      const s = docLower;
      expect(s).to.include("offline");
      expect(s).to.match(/no key/);
      expect(s).to.match(/no network/);
      // The 0/3 CI-gateable exit contract for both verify and verify-attest.
      expect(s).to.match(/ci-gateable|ci-gate/);
      expect(s).to.match(/exit 0|0 accepted|0 match/);
      expect(s).to.match(/exit 3|3 rejected|3 mismatch/);
      expect(s).to.match(/accepted/);
      expect(s).to.match(/rejected/);
    });

    it("names the parcel signed-container kind verbatim (distinct from the dataset one)", function () {
      expect(doc).to.include("verifyhash.parcel-attestation-signed");
      expect(doc).to.include("eip191-personal-sign");
      // States the cross-verify isolation against the dataset kind.
      expect(docLower).to.match(/does not.*cross-verify|cross-verify|not cross-verify/);
    });

    it("has a worked sender -> [signs, P-3] -> recipient verify-attest example", function () {
      expect(doc).to.include("vh parcel build");
      expect(doc).to.include("vh parcel attest");
      expect(doc).to.include("vh parcel verify-attest");
      const s = docLower;
      expect(s).to.match(/sender/);
      expect(s).to.match(/recipient/);
      // The human-signs step is called out explicitly (P-3) inside the example.
      expect(s).to.match(/human/);
      expect(doc).to.include("P-3");
    });

    it("CRITICALLY states the receipt is signable but NOT a trusted delivery TIMESTAMP (rides P-3)", function () {
      const s = docLower;
      expect(s).to.match(/binds the file set|file set/);
      expect(s).to.match(/signable/);
      expect(s).to.match(/not.*timestamp|not a trusted delivery timestamp/);
      expect(doc).to.include("P-3");
      expect(docLower).to.include("needs-human");
      // Never overclaims "delivered/unaltered since date T".
      expect(s).to.match(/delivered on date t|unaltered since/);
    });

    it("CRITICALLY states the parcel metadata is UNTRUSTED self-asserted (not bound into the root)", function () {
      expect(doc).to.include("UNTRUSTED");
      const s = docLower;
      expect(s).to.match(/self-asserted/);
      expect(s).to.match(/not.*bound into the (merkle )?root|not bound into the root/);
      // The specific metadata fields are named.
      expect(doc).to.match(/parcelId|parcel.?id/i);
      expect(doc).to.include("sender");
      expect(doc).to.include("recipient");
    });

    it("states the loop ships only the FORMAT + the OFFLINE VERIFIER (signature is the human P-3 step)", function () {
      expect(doc).to.include("FORMAT");
      const s = docLower;
      expect(s).to.match(/verifier/);
      expect(s).to.match(/throwaway|ephemeral|wallet\.createrandom/);
    });

    it("reuses the SAME honest trust posture as DataLedger (the in-band caveats, no drift)", function () {
      // The code's shared TRUST_NOTE clause and the parcel-specific caveat clause must be referenced in
      // the doc's prose (so the caveats can never drift between code and docs).
      expect(docLower).to.match(/same honest trust posture|same.*posture as dataledger/);
      // The load-bearing parcel caveat clause is carried in-band by the code; the doc must echo its claim.
      expect(parcel.PARCEL_TRUST_NOTE.toLowerCase()).to.match(/not a trusted/);
      expect(docLower).to.match(/not by itself a[\s]+trusted/);
    });
  });

  describe("README's `### Data-delivery receipts (ProofParcel)` section", function () {
    let section;
    before(function () {
      const start = readme.indexOf("### Data-delivery receipts (ProofParcel)");
      expect(start, "ProofParcel README section present").to.be.greaterThan(-1);
      const rest = readme.slice(start);
      const end = rest.indexOf("\n## ");
      section = end === -1 ? rest : rest.slice(0, end);
    });

    it("lists all four parcel commands", function () {
      expect(section).to.match(/vh parcel build[^\n]+/);
      expect(section).to.match(/vh parcel verify[^\n]+/);
      expect(section).to.match(/vh parcel attest[^\n]+/);
      expect(section).to.match(/vh parcel verify-attest[^\n]+/);
    });

    it("advertises offline / no key / no network / CI-gateable exit for the section", function () {
      const s = section.toLowerCase();
      expect(s).to.include("offline");
      expect(s).to.match(/no key/);
      expect(s).to.match(/no network/);
      expect(s).to.match(/exit code|exit 0|0 accepted|ci-gateable/);
    });

    it("states the build ships only FORMAT + VERIFIER, does not overclaim a delivery timestamp, links P-3", function () {
      const s = section.toLowerCase();
      expect(section).to.include("P-3");
      expect(s).to.match(/format/);
      expect(s).to.match(/verifier/);
      expect(s).to.match(/not.*timestamp|unaltered since/);
      // UNTRUSTED self-asserted parcel metadata is called out.
      expect(section).to.include("UNTRUSTED");
    });

    it("cross-links docs/PROOFPARCEL.md", function () {
      expect(section).to.include("docs/PROOFPARCEL.md");
    });

    it("the top CLI quick-list mentions all four parcel commands", function () {
      const block = readme.split("```").find((b) => b.includes("vh hash") && b.includes("vh dataset build"));
      expect(block, "top CLI fenced block").to.be.a("string");
      expect(block).to.match(/vh parcel build[^\n]+/);
      expect(block).to.match(/vh parcel verify[^\n]+/);
      expect(block).to.match(/vh parcel attest[^\n]+/);
      expect(block).to.match(/vh parcel verify-attest[^\n]+/);
    });
  });
});

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// T-19.3 docs-rot guard for the SIGNING leg (`vh dataset sign` / `vh parcel sign`) + the sharpened
// P-3/P-4 handoff.
//
// Pure (no chain, no fixtures): asserts docs/DATALEDGER.md, docs/PROOFPARCEL.md, README.md, and
// STRATEGY.md document the T-19.1/T-19.2 signing command the way the code actually behaves, so the
// buyer-/operator-facing prose can't silently drift from cli/dataset.js + cli/parcel.js. Load-bearing
// properties under test (the acceptance criteria of T-19.3):
//   * docs/DATALEDGER.md + docs/PROOFPARCEL.md document `vh dataset/parcel sign --key-env/--key-file`,
//     the worked attest -> sign -> verify-attest example, the "read-only of a key YOU provisioned; never
//     generates/persists/logs a key; offline; no network" property, and the inherited honest posture
//     (a self-managed-key signature attests the IDENTITY + "the signer says so", NOT a trusted timestamp),
//   * README's command tables list the two `sign` subcommands,
//   * STRATEGY.md P-3 and P-4 collapse the Option (A) handoff to provision-a-key + run `sign`, the buyer
//     verifies with the existing verify-attest,
//   * the caveats reuse the shared SIGN_TRUST_NOTE wording so they never drift.
// ---------------------------------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

// Importing the modules pins the in-band caveat wording this guard reuses AND fails loudly if the sign
// runners/caveats are ever removed — the docs guard would otherwise be hollow.
const dataset = require("../cli/dataset");
const parcel = require("../cli/parcel");

describe("T-19.3 docs: `vh dataset/parcel sign` documented + P-3/P-4 sharpened", function () {
  let dl, dlLower, pp, ppLower, readme, strategy;

  before(function () {
    dl = read("docs/DATALEDGER.md");
    dlLower = dl.toLowerCase();
    pp = read("docs/PROOFPARCEL.md");
    ppLower = pp.toLowerCase();
    readme = read("README.md");
    strategy = read("STRATEGY.md");
  });

  it("the sign runners + SIGN_TRUST_NOTE this guard pins against still exist", function () {
    // Tripwire: if the sign command is dropped, the assertions below would be meaningless.
    expect(dataset.runDatasetSign, "dataset.runDatasetSign export").to.be.a("function");
    expect(dataset.SIGN_TRUST_NOTE, "dataset.SIGN_TRUST_NOTE export").to.be.a("string");
    expect(parcel.runParcelSign, "parcel.runParcelSign export").to.be.a("function");
    expect(parcel.SIGN_TRUST_NOTE, "parcel.SIGN_TRUST_NOTE export").to.be.a("string");
  });

  // The shared, load-bearing clauses the docs must reuse verbatim so the caveats can never drift from the
  // code. Both products' SIGN_TRUST_NOTE carry these exact substrings.
  const SHARED_CLAUSES = [
    'self-managed key attests "the signer says so"',
    "it is NOT an independent, trusted TIMESTAMP",
    "The key must be one YOU provisioned OUTSIDE this tool",
  ];

  it("both products' SIGN_TRUST_NOTE carry the shared honest-posture clauses (no drift at the source)", function () {
    for (const clause of SHARED_CLAUSES) {
      expect(dataset.SIGN_TRUST_NOTE, `dataset SIGN_TRUST_NOTE clause: ${clause}`).to.include(clause);
      expect(parcel.SIGN_TRUST_NOTE, `parcel SIGN_TRUST_NOTE clause: ${clause}`).to.include(clause);
    }
  });

  describe("docs/DATALEDGER.md", function () {
    it("documents `vh dataset sign` with --key-env AND --key-file", function () {
      expect(dl).to.include("vh dataset sign");
      expect(dl).to.include("--key-env");
      expect(dl).to.include("--key-file");
    });
    it("read-only of YOUR key; never generates/persists/logs a key; offline; no network", function () {
      expect(dlLower).to.match(/read-only of a key you provisioned|provisioned outside/);
      expect(dlLower).to.match(/never generate/);
      expect(dlLower).to.match(/persist/);
      expect(dlLower).to.match(/log/);
      expect(dlLower).to.match(/offline/);
      expect(dlLower).to.match(/no network/);
    });
    it("worked attest -> sign -> verify-attest example with a key source", function () {
      expect(dl).to.include("vh dataset attest");
      expect(dl).to.include("vh dataset sign");
      expect(dl).to.include("vh dataset verify-attest");
      expect(dl).to.match(/vh dataset sign[\s\S]{0,120}--key-(env|file)/);
    });
    it("honest posture: IDENTITY + 'the signer says so', NOT a timestamp (still P-3)", function () {
      expect(dlLower).to.match(/the signer says so/);
      expect(dlLower).to.match(/unaltered since/);
      expect(dl).to.include("P-3");
      expect(dl).to.include('self-managed key attests "the signer says so"');
    });
    it("command table lists `vh dataset sign`", function () {
      const rows = dl.split("\n").filter((l) => l.trim().startsWith("|"));
      expect(rows.join("\n")).to.include("vh dataset sign");
    });
  });

  describe("docs/PROOFPARCEL.md", function () {
    it("documents `vh parcel sign` with --key-env AND --key-file", function () {
      expect(pp).to.include("vh parcel sign");
      expect(pp).to.include("--key-env");
      expect(pp).to.include("--key-file");
    });
    it("read-only of YOUR key; never generates/persists/logs a key; offline; no network", function () {
      expect(ppLower).to.match(/read-only of a key you provisioned|provisioned outside/);
      expect(ppLower).to.match(/never generate/);
      expect(ppLower).to.match(/persist/);
      expect(ppLower).to.match(/log/);
      expect(ppLower).to.match(/offline/);
      expect(ppLower).to.match(/no network/);
    });
    it("worked attest -> sign -> verify-attest example with a key source", function () {
      expect(pp).to.include("vh parcel attest");
      expect(pp).to.include("vh parcel sign");
      expect(pp).to.include("vh parcel verify-attest");
      expect(pp).to.match(/vh parcel sign[\s\S]{0,120}--key-(env|file)/);
    });
    it("honest posture: IDENTITY + 'the signer says so', NOT a timestamp (still P-3)", function () {
      expect(ppLower).to.match(/the signer says so/);
      expect(ppLower).to.match(/unaltered since/);
      expect(pp).to.include("P-3");
      expect(pp).to.include('self-managed key attests "the signer says so"');
    });
    it("command table lists `vh parcel sign`", function () {
      const rows = pp.split("\n").filter((l) => l.trim().startsWith("|"));
      expect(rows.join("\n")).to.include("vh parcel sign");
    });
  });

  describe("README command tables list the two `sign` subcommands", function () {
    it("top CLI fenced block lists `vh dataset sign` and `vh parcel sign`", function () {
      const block = readme.split("```").find((b) => b.includes("vh hash") && b.includes("vh dataset build"));
      expect(block, "top CLI fenced block").to.be.a("string");
      expect(block).to.match(/vh dataset sign[^\n]*--key-env/);
      expect(block).to.match(/vh parcel sign[^\n]*--key-env/);
    });

    it("the DataLedger fenced block lists `vh dataset sign` with --key-env|--key-file", function () {
      const start = readme.indexOf("### Dataset provenance (DataLedger)");
      const rest = readme.slice(start);
      const end = rest.indexOf("\n## ");
      const section = end === -1 ? rest : rest.slice(0, end);
      expect(section).to.match(/vh dataset sign[^\n]*--key-env[^\n]*--key-file/);
    });

    it("the ProofParcel fenced block lists `vh parcel sign` with --key-env|--key-file", function () {
      const start = readme.indexOf("### Data-delivery receipts (ProofParcel)");
      const rest = readme.slice(start);
      const end = rest.indexOf("\n## ");
      const section = end === -1 ? rest : rest.slice(0, end);
      expect(section).to.match(/vh parcel sign[^\n]*--key-env[^\n]*--key-file/);
    });
  });

  describe("STRATEGY.md P-3/P-4 collapse the Option (A) handoff to provision-a-key + run `sign`", function () {
    let p3, p4;
    before(function () {
      const p3Start = strategy.indexOf("- **P-3 (");
      expect(p3Start, "P-3 proposal present").to.be.greaterThan(-1);
      const p4Start = strategy.indexOf("- **P-4 (", p3Start);
      expect(p4Start, "P-4 proposal present").to.be.greaterThan(p3Start);
      p3 = strategy.slice(p3Start, p4Start);
      p4 = strategy.slice(p4Start);
    });

    it("P-3 says the loop now ALSO ships the SIGNING command and names `vh dataset sign --key-env`", function () {
      expect(p3).to.match(/vh dataset sign[^\n]*--key-env/);
      // The handoff collapses to provision + run sign.
      expect(p3.toLowerCase()).to.match(/provision/);
      expect(p3.toLowerCase()).to.match(/collapse/);
    });

    it("P-3 keeps the buyer-verifies-with-existing-verify-attest leg", function () {
      expect(p3).to.include("vh dataset verify-attest");
    });

    it("P-3 still keeps the loop honest: never generates/persists a real key; not a timestamp on its own", function () {
      const s = p3.toLowerCase();
      expect(s).to.match(/never generate|never (generates|persists|holds)/);
      expect(s).to.match(/not.*timestamp|never.*claims a timestamp|unaltered since/);
    });

    it("P-4 (ProofParcel) collapses to provision + `vh parcel sign --key-env`, buyer verify-attests", function () {
      expect(p4).to.match(/vh parcel sign[^\n]*--key-env/);
      expect(p4).to.include("vh parcel verify-attest");
      expect(p4.toLowerCase()).to.match(/provision/);
    });
  });
});

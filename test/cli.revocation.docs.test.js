"use strict";

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// T-51.3 docs-rot guard for the PRODUCER KEY REVOCATION (`vh revocation publish|verify`).
//
// Pure (no chain, no fixtures, no filesystem effects): asserts that docs/KEY-LIFECYCLE.md, docs/EVIDENCE.md,
// STRATEGY.md, and README.md keep documenting the revocation surface the way cli/revocation.js + the PURE
// core actually behave — so the prose (the recipient's "was this key still good when THIS exhibit was
// sealed?" pin-point) can never silently drift from the implementation. Pure documentation of the T-51.1/
// T-51.3 runtime; no new behaviour.
//
// The load-bearing properties under test:
//   * docs/KEY-LIFECYCLE.md documents the publish→pin→verify flow + the publish/verify command surface
//     (mint with a provisioned key that MUST control --address — a key revokes ITSELF; verify recovers the
//     signer + requires it to BE the revocation's vendorAddress; the 0/3/2/1 exit contract; filesystem
//     hygiene — default prints + writes NOTHING, --out never cwd),
//   * docs/KEY-LIFECYCLE.md states the "signed claim, NOT a trusted timestamp without P-3" boundary VERBATIM
//     and pins the standing REVOCATION_TRUST_NOTE verbatim (so the doc can't drift from the code's caveat),
//   * STRATEGY.md P-7 step 1 carries a one-line revocation pointer to `vh revocation publish` +
//     docs/KEY-LIFECYCLE.md, adding NO new human gate (no new needs-human item; P-3/P-4/P-5/P-6/P-8 untouched),
//   * docs/EVIDENCE.md documents the recipient `--revocations` step on verify-signed,
//   * README's CLI block + a short section list `vh revocation publish|verify` and cross-link docs/KEY-LIFECYCLE.md.
// ---------------------------------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

// Importing the modules fails this suite loudly if the revocation surface or its caveats are ever removed,
// and lets us pin the docs to the exact phrases the code exports so they cannot drift.
const REV = require("../cli/revocation");
const coreRevocation = require("../cli/core/revocation");

// The verbatim boundary phrase STRATEGY.md says is stated verbatim in docs/KEY-LIFECYCLE.md.
const VERBATIM_BOUNDARY =
  'a revocation is a SIGNED CLAIM by the key-holder (it proves the key-holder SAID "revoked as of D"); ' +
  "it is NOT a trusted wall-clock timestamp without P-3";

describe("T-51.3 docs: docs/KEY-LIFECYCLE.md + STRATEGY.md + EVIDENCE.md + README document the key revocation", function () {
  const keyLifecycle = read("docs/KEY-LIFECYCLE.md");
  const klLower = keyLifecycle.toLowerCase();
  const evidence = read("docs/EVIDENCE.md");
  const strategy = read("STRATEGY.md");
  const readme = read("README.md");
  const readmeLower = readme.toLowerCase();

  it("the revocation module + core still export the surface this guard pins against", function () {
    // Tripwire: if cli/revocation.js (or the core) drops these, the docs guards below describe nothing.
    expect(REV.cmdRevocation, "cmdRevocation export").to.be.a("function");
    expect(REV.runRevocationPublish, "runRevocationPublish export").to.be.a("function");
    expect(REV.runRevocationVerify, "runRevocationVerify export").to.be.a("function");
    expect(REV.VERIFY_TRUST_NOTE, "VERIFY_TRUST_NOTE export").to.be.a("string");
    expect(coreRevocation.REVOCATION_TRUST_NOTE, "REVOCATION_TRUST_NOTE export").to.be.a("string");
    expect(coreRevocation.REVOCATION_REASON_SET, "REVOCATION_REASON_SET export").to.be.an("array");
    // The exit contract the docs pin (0 ok/ACCEPTED / 1 IO / 2 usage / 3 REJECTED).
    expect(REV.EXIT).to.deep.equal({ OK: 0, IO: 1, USAGE: 2, FAIL: 3 });
  });

  describe("docs/KEY-LIFECYCLE.md documents the publish→pin→verify flow", function () {
    it("documents the publish → pin → verify lifecycle by name", function () {
      // The three lifecycle moves are documented (case-insensitively) as a flow.
      expect(klLower).to.match(/publish\s*[→\-> ]+\s*pin\s*[→\-> ]+\s*verify/);
      expect(keyLifecycle).to.include("Publish");
      expect(keyLifecycle).to.include("Pin");
      expect(keyLifecycle).to.include("Verify");
    });

    it("names both subcommands", function () {
      expect(keyLifecycle).to.include("vh revocation publish");
      expect(keyLifecycle).to.include("vh revocation verify");
    });

    it("documents the load-bearing self-control invariant: a key revokes ITSELF, mints ONLY when the key controls --address", function () {
      expect(klLower).to.match(/a key revokes itself/);
      expect(klLower).to.match(/third party cannot revoke a key it does not control/);
      expect(klLower).to.match(/only\W{0,6}when .{0,60}equals\W{0,12}--address/);
      expect(klLower).to.match(/before writing/);
    });

    it("documents the key posture: a human-provisioned key, read-used-discarded, never held/logged", function () {
      expect(klLower).to.match(/human-provisioned key/);
      expect(klLower).to.match(/read-used-discarded/);
      expect(klLower).to.match(/never\W{0,30}generates|loop\W{0,6}never/);
    });

    it("documents verify: recover the signer + require it to BE the revocation's vendorAddress + optionally pin --signer", function () {
      expect(keyLifecycle).to.include("vendorAddress");
      expect(klLower).to.match(/recover/);
      expect(klLower).to.match(/is the revocation's own `?vendoraddress`?|recovered signer .{0,20}is.{0,20}vendoraddress/);
      expect(keyLifecycle).to.include("--signer");
    });

    it("documents that a forged/tampered/third-party revocation is a clean REJECTED, never a silent pass", function () {
      expect(keyLifecycle).to.include("REJECTED");
      expect(klLower).to.match(/never a silent pass/);
      expect(klLower).to.match(/forged|tampered|third party|third-party/);
    });

    it("documents the exit contract (0 ACCEPTED / 3 REJECTED / 2 usage / 1 IO)", function () {
      expect(klLower).to.match(/0\D{0,18}accepted/);
      expect(klLower).to.match(/3\D{0,18}rejected/);
      expect(klLower).to.match(/2\D{0,18}usage/);
      expect(klLower).to.match(/1\D{0,18}io/);
    });

    it("documents filesystem hygiene: default prints + writes NOTHING; --out never cwd", function () {
      expect(klLower).to.match(/writes? nothing/);
      expect(klLower).to.match(/never (silently )?to cwd|never .{0,10}cwd/);
      expect(keyLifecycle).to.include("--out");
    });

    it("documents the closed --reason set verbatim (every reason the core accepts)", function () {
      for (const r of coreRevocation.REVOCATION_REASON_SET) {
        expect(keyLifecycle, `reason ${r}`).to.include(r);
      }
    });

    it("documents the recipient --revocations / --as-of downgrade rule (revoked-before-as-of -> REVOKED; non-loosening)", function () {
      expect(keyLifecycle).to.include("--revocations");
      expect(keyLifecycle).to.include("--as-of");
      expect(klLower).to.match(/revoked-before-as-of|revoked-before the as-of|revoked-before/);
      expect(klLower).to.match(/non-loosening|byte-for-byte|strictly optional/);
    });
  });

  describe("docs/KEY-LIFECYCLE.md carries the 'signed claim, NOT a trusted timestamp without P-3' boundary VERBATIM", function () {
    it("states the boundary phrase VERBATIM (so the doc can't drift from STRATEGY.md)", function () {
      expect(keyLifecycle).to.include(VERBATIM_BOUNDARY);
    });
    it("pins the standing REVOCATION_TRUST_NOTE VERBATIM (so the doc can't drift from the code)", function () {
      expect(keyLifecycle).to.include(coreRevocation.REVOCATION_TRUST_NOTE);
    });
    it("STRATEGY.md states the same boundary (P-7 prose is line-wrapped, so match the unbroken sub-phrases)", function () {
      // STRATEGY.md hard-wraps the pointer prose, so the phrase spans newlines there. Assert its load-bearing
      // sub-phrases (which do not straddle a wrap) rather than the single-line form the standalone doc pins.
      const sLower = strategy.toLowerCase();
      expect(strategy).to.include("a revocation is a SIGNED CLAIM by the");
      expect(sLower).to.match(/it proves the key-holder said "revoked as of d"/);
      expect(sLower).to.match(/not a trusted wall-clock timestamp without p-3/);
    });
  });

  describe("STRATEGY.md P-7 step 1 carries the one-line revocation pointer (no new human gate)", function () {
    // Slice P-7 (from its definition header to the start of P-8) so the assertions are LOCAL to P-7.
    const p7 = strategy.slice(
      strategy.indexOf("- **P-7 (2026-06-24)"),
      strategy.indexOf("- **P-8 (2026-06-24)")
    );
    it("P-7 was located in STRATEGY.md", function () {
      expect(p7.length, "P-7 slice").to.be.greaterThan(200);
    });
    it("P-7 step 1 points at `vh revocation publish` + docs/KEY-LIFECYCLE.md as a SHARPENING", function () {
      expect(p7).to.match(/SHARPENING \(EPIC-51/);
      expect(p7).to.include("vh revocation publish");
      expect(p7).to.include("docs/KEY-LIFECYCLE.md");
    });
    it("the P-7 SHARPENING adds NO new human gate (changes no key/price/partner step)", function () {
      expect(p7.toLowerCase()).to.match(/no new human gate/);
      expect(p7.toLowerCase()).to.match(/changes no key\/price\/partner step|no key\/price\/partner/);
    });
    it("the P-7 SHARPENING repeats the SIGNED-CLAIM / not-a-trusted-timestamp-without-P-3 boundary", function () {
      expect(p7).to.match(/SIGNED CLAIM/);
      expect(p7.toLowerCase()).to.match(/not a trusted wall-clock timestamp without p-3/);
    });
  });

  describe("STRATEGY.md: no NEW needs-human item, and P-3/P-4/P-5/P-6/P-8 untouched by this task", function () {
    it("the EPIC-51 Direction note states T-51.3 adds NO new needs-human item + no change to P-3/P-4/P-5/P-6/P-8", function () {
      // The planning note that owns this task explicitly disclaims any new gate / P-3..P-8 change.
      expect(strategy).to.match(/NO new `needs-human` item; T-51\.3/);
      expect(strategy).to.match(/NO change to P-3\/P-4\/P-5\/P-6\/P-8/);
    });
  });

  describe("docs/EVIDENCE.md documents the recipient --revocations step on verify-signed", function () {
    const evLower = evidence.toLowerCase();
    it("names the --revocations / --as-of flags on verify-signed", function () {
      expect(evidence).to.include("--revocations");
      expect(evidence).to.include("--as-of");
      expect(evidence).to.include("verify-signed");
    });
    it("documents the revoked-before-as-of -> REVOKED downgrade as strictly optional + non-loosening", function () {
      expect(evidence).to.include("REVOKED");
      expect(evLower).to.match(/non-loosening|byte-for-byte/);
      expect(evLower).to.match(/strictly optional|optional/);
    });
    it("cross-links docs/KEY-LIFECYCLE.md", function () {
      expect(evidence).to.include("docs/KEY-LIFECYCLE.md");
    });
  });

  describe("README lists vh revocation and cross-links docs/KEY-LIFECYCLE.md", function () {
    it("the CLI fenced block lists vh revocation publish + verify", function () {
      const block = readme.split("```").find((b) => b.includes("vh hash") && b.includes("vh parcel verify"));
      expect(block, "CLI fenced block").to.be.a("string");
      const pub = block.split("\n").find((l) => l.includes("vh revocation publish"));
      const ver = block.split("\n").find((l) => l.includes("vh revocation verify"));
      expect(pub, "vh revocation publish CLI line").to.be.a("string");
      expect(ver, "vh revocation verify CLI line").to.be.a("string");
      expect(pub).to.match(/#[^\n]+/); // has a description
      expect(ver.toLowerCase()).to.match(/rejected/);
    });

    it("a README section documents revocation with the self-control rule + the caveats + cross-link", function () {
      expect(readme).to.include("vh revocation");
      expect(readmeLower).to.match(/a key revokes itself/);
      expect(readmeLower).to.match(/third party cannot revoke a key it does not control/);
      expect(readmeLower).to.match(/not a trusted timestamp/);
      expect(readmeLower).to.match(/not.{0,5}a legal opinion/);
      expect(readme).to.include("docs/KEY-LIFECYCLE.md");
    });
  });
});

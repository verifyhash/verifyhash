"use strict";

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// T-49.3 docs-rot guard for the PRODUCER IDENTITY CARD (`vh identity publish|verify`).
//
// Pure (no chain, no fixtures, no filesystem effects): asserts that docs/IDENTITY.md, STRATEGY.md, and
// README.md keep documenting the identity card the way cli/identity.js actually behaves — so the prose
// (the recipient's / cold prospect's "who is this vendor + what do they attest?" pin-point) can never
// silently drift from the implementation. Pure documentation of the T-49.1/T-49.2 runtime; no new behaviour.
//
// The load-bearing properties under test:
//   * docs/IDENTITY.md documents the publish/verify FLOW (mint with a provisioned key that MUST control
//     --address; verify recovers the signer + requires it to BE the card's vendorAddress; the 0/3/2/1
//     exit contract; filesystem hygiene — default prints + writes NOTHING, --out never cwd),
//   * docs/IDENTITY.md documents the PIN-ONCE-TRUST-ACROSS-HANDOFFS model (pin the vendorAddress once,
//     reuse it across every later signed handoff with no new out-of-band step),
//   * docs/IDENTITY.md carries the IDENTITY-not-packet-truth / NOT-timestamp / NOT-legal boundary, and
//     pins the standing IDENTITY_CARD_TRUST_NOTE VERBATIM (so the doc can't drift from the code's caveat),
//   * STRATEGY.md P-7 step 1 AND P-6 step 1 carry a one-line SHARPENING pointer to `vh identity publish`
//     + docs/IDENTITY.md, adding NO new human gate (P-3/P-4/P-5/P-8 untouched, no new needs-human item),
//   * README's CLI block + a short section list `vh identity publish|verify` and cross-link docs/IDENTITY.md.
// ---------------------------------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

// Importing the module fails this suite loudly if the identity surface or its caveats are ever removed,
// and lets us pin the docs to the exact phrases the code exports so they cannot drift.
const ID = require("../cli/identity");

describe("T-49.3 docs: docs/IDENTITY.md + STRATEGY.md + README document the producer identity card", function () {
  const idDoc = read("docs/IDENTITY.md");
  const idLower = idDoc.toLowerCase();
  // The live P-1..P-8 proposals stay in STRATEGY.md; the SUPERSEDED `## Direction` planning notes (incl. the
  // EPIC-49 note this suite checks) were relocated byte-for-byte to docs/STRATEGY-ARCHIVE.md by T-56.2. Read
  // both so the historical disclaimer is still found wherever it now lives. STRATEGY.md comes first, so the
  // P-6/P-7/P-8 proposal `indexOf` slices below still resolve to the proposals section.
  const strategy = read("STRATEGY.md") + "\n" + read("docs/STRATEGY-ARCHIVE.md");
  const readme = read("README.md");
  const readmeLower = readme.toLowerCase();

  it("the identity module still exports the surface this guard pins against", function () {
    // Tripwire: if cli/identity.js drops these, the docs guards below describe nothing.
    expect(ID.cmdIdentity, "cmdIdentity export").to.be.a("function");
    expect(ID.runIdentityPublish, "runIdentityPublish export").to.be.a("function");
    expect(ID.runIdentityVerify, "runIdentityVerify export").to.be.a("function");
    expect(ID.IDENTITY_CARD_TRUST_NOTE, "IDENTITY_CARD_TRUST_NOTE export").to.be.a("string");
    expect(ID.VERIFY_TRUST_NOTE, "VERIFY_TRUST_NOTE export").to.be.a("string");
    expect(ID.PRODUCT_LINE_SET, "PRODUCT_LINE_SET export").to.be.an("array");
    // The exit contract the docs pin (0 ok/ACCEPTED / 1 IO / 2 usage / 3 REJECTED).
    expect(ID.EXIT).to.deep.equal({ OK: 0, IO: 1, USAGE: 2, FAIL: 3 });
  });

  describe("docs/IDENTITY.md documents the publish/verify FLOW", function () {
    it("names both subcommands", function () {
      expect(idDoc).to.include("vh identity publish");
      expect(idDoc).to.include("vh identity verify");
    });

    it("documents the load-bearing mint invariant: mints ONLY when the key controls --address", function () {
      // The key must control the address it claims; a mismatch hard-errors BEFORE any write.
      expect(idLower).to.match(/controls? the address it claims/);
      expect(idLower).to.match(/only\W{0,6}when .{0,60}equals\W{0,12}--address/);
      expect(idLower).to.match(/before writing/);
    });

    it("documents the key posture: a human-provisioned key, read-used-discarded, never held/logged", function () {
      expect(idLower).to.match(/human-provisioned key|key you provisioned/);
      expect(idLower).to.match(/read-used-discarded/);
      expect(idLower).to.match(/never\W{0,6}generates.{0,30}logs|loop\W{0,6}never/);
    });

    it("documents verify: recover the signer + require it to BE the card's vendorAddress + optionally pin --signer", function () {
      expect(idDoc).to.include("vendorAddress");
      expect(idLower).to.match(/recover/);
      expect(idLower).to.match(/is the card's own `?vendoraddress`?|recovered signer .{0,20}is.{0,20}vendoraddress/);
      expect(idDoc).to.include("--signer");
    });

    it("documents that a forged/tampered/wrong card is a clean REJECTED, never a silent pass", function () {
      expect(idDoc).to.include("REJECTED");
      expect(idLower).to.match(/never a silent pass/);
      expect(idLower).to.match(/forged|tampered/);
    });

    it("documents the exit contract (0 ACCEPTED / 3 REJECTED / 2 usage / 1 IO)", function () {
      expect(idLower).to.match(/0\D{0,12}accepted/);
      expect(idLower).to.match(/3\D{0,12}rejected/);
      expect(idLower).to.match(/2\D{0,12}usage/);
      expect(idLower).to.match(/1\D{0,12}io/);
    });

    it("documents filesystem hygiene: default prints + writes NOTHING; --out never cwd", function () {
      expect(idLower).to.match(/writes? nothing/);
      expect(idLower).to.match(/never (silently )?to cwd|never .{0,10}cwd/);
      expect(idDoc).to.include("--out");
    });
  });

  describe("docs/IDENTITY.md documents the PIN-ONCE-TRUST-ACROSS-HANDOFFS model", function () {
    it("has a pin-once / trust-across-handoffs heading or phrasing", function () {
      expect(idLower).to.match(/pin once.{0,40}trust across handoffs|pin-once-trust-across-handoffs/);
    });

    it("says the recipient does the out-of-band trust step ONCE, then reuses the pin with no new step", function () {
      expect(idLower).to.match(/out of band|out-of-band/);
      expect(idLower).to.match(/once/);
      expect(idLower).to.match(/reuse/);
      // every later handoff reuses the SAME pinned vendorAddress (no re-pinning).
      expect(idLower).to.match(/handoff/);
      expect(idLower).to.match(/no new out-of-band step|no re-pinning|no new .{0,20}step/);
    });
  });

  describe("docs/IDENTITY.md carries the IDENTITY-not-packet-truth / NOT-timestamp / NOT-legal boundary", function () {
    it("pins the standing IDENTITY_CARD_TRUST_NOTE VERBATIM (so the doc can't drift from the code)", function () {
      // The exact caveat string the publish/verify paths LEAD with — embedded verbatim in the doc.
      expect(idDoc).to.include(ID.IDENTITY_CARD_TRUST_NOTE);
    });

    it("states it proves IDENTITY + the claim SET, NOT any specific packet's truth", function () {
      expect(idLower).to.match(/identity \+ the claim set/);
      expect(idLower).to.match(/not .{0,30}packet|each .{0,20}packet carries its own proof/);
    });

    it("states it is NOT a trusted timestamp (P-3)", function () {
      expect(idLower).to.match(/not a trusted timestamp/);
      expect(idDoc).to.match(/P-3/);
    });

    it("states it is NOT a legal opinion", function () {
      expect(idLower).to.match(/not a legal opinion/);
    });
  });

  describe("STRATEGY.md P-7 step 1 carries the SHARPENING pointer (no new human gate)", function () {
    // Slice P-7 (from its definition header to the start of P-8) so the assertions are LOCAL to P-7.
    const p7 = strategy.slice(
      strategy.indexOf("- **P-7 (2026-06-24)"),
      strategy.indexOf("- **P-8 (2026-06-24)")
    );
    it("P-7 was located in STRATEGY.md", function () {
      expect(p7.length, "P-7 slice").to.be.greaterThan(200);
    });
    it("P-7 step 1 points at `vh identity publish` + docs/IDENTITY.md as a SHARPENING", function () {
      expect(p7).to.match(/SHARPENING \(EPIC-49/);
      expect(p7).to.include("vh identity publish");
      expect(p7).to.include("docs/IDENTITY.md");
    });
    it("the P-7 SHARPENING adds NO new human gate", function () {
      expect(p7.toLowerCase()).to.match(/no new human gate/);
    });
    it("the P-7 SHARPENING repeats the IDENTITY-not-packet-truth / not-timestamp / not-legal boundary", function () {
      expect(p7.toLowerCase()).to.match(/not packet truth/);
      expect(p7.toLowerCase()).to.match(/not a timestamp \(p-3\)/);
      expect(p7.toLowerCase()).to.match(/not a legal opinion/);
    });
  });

  describe("STRATEGY.md P-6 step 1 carries the SHARPENING pointer (no new human gate)", function () {
    // Slice P-6 (from its definition header to the start of P-7) so the assertions are LOCAL to P-6.
    const p6 = strategy.slice(
      strategy.indexOf("- **P-6 (2026-06-24)"),
      strategy.indexOf("- **P-7 (2026-06-24)")
    );
    it("P-6 was located in STRATEGY.md", function () {
      expect(p6.length, "P-6 slice").to.be.greaterThan(200);
    });
    it("P-6 step 1 points at `vh identity publish` + docs/IDENTITY.md as a SHARPENING", function () {
      expect(p6).to.match(/SHARPENING \(EPIC-49/);
      expect(p6).to.include("vh identity publish");
      expect(p6).to.include("docs/IDENTITY.md");
    });
    it("the P-6 SHARPENING adds NO new human gate", function () {
      expect(p6.toLowerCase()).to.match(/no new human gate/);
    });
  });

  describe("STRATEGY.md: no new needs-human item, and P-3/P-4/P-5/P-8 are untouched by this task", function () {
    it("the EPIC-49 Direction note states T-49.3 adds NO new needs-human item + no change to P-3/P-4/P-5", function () {
      // The planning note that owns this task explicitly disclaims any new gate / P-3/P-4/P-5 change.
      expect(strategy).to.match(/NO new `needs-human` item; T-49\.3 only adds a crisp one-line pointer/);
      expect(strategy).to.match(/NO change to P-3\/P-4\/P-5/);
    });
  });

  describe("README lists vh identity and cross-links docs/IDENTITY.md", function () {
    it("the CLI fenced block lists vh identity publish + verify", function () {
      const block = readme.split("```").find((b) => b.includes("vh hash") && b.includes("vh parcel verify"));
      expect(block, "CLI fenced block").to.be.a("string");
      const pub = block.split("\n").find((l) => l.includes("vh identity publish"));
      const ver = block.split("\n").find((l) => l.includes("vh identity verify"));
      expect(pub, "vh identity publish CLI line").to.be.a("string");
      expect(ver, "vh identity verify CLI line").to.be.a("string");
      expect(pub).to.match(/#[^\n]+/); // has a description
      expect(ver.toLowerCase()).to.match(/rejected/);
    });

    it("a README section documents the card with the pin-once model + the caveats + cross-link", function () {
      expect(readme).to.include("vh identity");
      expect(readmeLower).to.match(/pin once.{0,40}trust across handoffs/);
      expect(readmeLower).to.match(/identity \+ the claim set only/);
      expect(readmeLower).to.match(/not a trusted timestamp/);
      expect(readmeLower).to.match(/not.{0,5}a legal opinion/);
      expect(readme).to.include("docs/IDENTITY.md");
    });
  });
});

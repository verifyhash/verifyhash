"use strict";

// ---------------------------------------------------------------------------
// T-65.3 docs-rot guard for the ZERO-INSTALL pilot path (the offline single-file app).
//
// Pure (no chain, no server, no network): asserts that the buyer/operator-facing docs keep
// describing the T-65.2 deliverable — trustledger/dist/trustledger-standalone.html — the way it
// actually behaves, and that wiring it into the sharpened P-5 ask deleted or relaxed NOTHING
// human-owned. Load-bearing properties under test:
//
//   * docs/TRUSTLEDGER.md and docs/PILOT.md each carry a "Zero-install: the offline app" section
//     that NAMES the file (`trustledger-standalone.html`), describes the FLOW (the human emails ONE
//     file / hands it on a USB stick; the partner double-clicks it and drags their REAL bank /
//     ledger / rent-roll exports in; they read the same tie-out report) and frame the free surface
//     HONESTLY as TWO INDEPENDENT monthly tie-outs (month-1 + month-2, the WTP signal) — NOT the
//     machine-checked continuity roll-forward, which (no CONTINUITY_BREAK via --emit-close /
//     --prior-close) stays an installed-CLI capability the offline app's UI does not expose.
//   * the privacy claim is stated HONESTLY and VERIFIABLY: the page makes NO network request, the
//     file contains no network API, "check the browser devtools Network tab yourself", and the
//     data never leaves the machine — AND that claim is anchored to the shipped bytes (this test
//     re-scans the committed dist bundle for the network-API tokens, so the prose cannot outlive
//     the property).
//   * the honesty boundary is stated VERBATIM in both docs: the offline app is the FREE funnel
//     tier; per-state policy / sealing / licensing run in the installed product; P-5's human steps
//     stay human-owned and unchanged (no new needs-human item, no relaxed gate).
//   * one-line pointers exist in docs/ADOPT.md, docs/GO-LIVE.md's pilot-fallback paragraph, and
//     pilot/README.md — so every funnel doc reaches the zero-install path.
//   * the P-line grep: STRATEGY.md's P-3 / P-5 / P-6 / P-8 / P-9 proposal blocks still exist in
//     the needs-human section, still carry their key human steps, and still carry their "MUST
//     NOT be auto-executed"-class language — i.e. NO human step was deleted or relaxed by this
//     docs work.
//   * the artifacts the docs reference actually exist (the dist bundle + sidecar + provenance,
//     the builder, the pinning test), so the prose can't point at vapor.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(REPO, rel));

// Soft-wrap-tolerant verbatim matching (the docs wrap long lines; the words must not change).
const norm = (s) => s.replace(/\s+/g, " ");

// The task-mandated honesty boundary, VERBATIM (tolerating only the leading article's
// sentence-capitalisation — every load-bearing clause is matched word-for-word, case-sensitively).
const BOUNDARY_VERBATIM =
  "offline app is the FREE funnel tier — per-state policy tables, sealing, and " +
  "licensing/fulfillment run in the installed product, and P-5's CPA/counsel review, vendor-key " +
  "provisioning, pricing, and publishing steps remain HUMAN-OWNED and UNCHANGED (no new " +
  "needs-human item, no relaxed gate).";

// The SAME network-API token list test/trustledger.standalone.test.js pins — re-asserted here so
// the docs' "the file contains no network API" sentence is anchored to the shipped bytes.
const NETWORK_TOKENS = ["fetch(", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "import("];

const BUNDLE_REL = "trustledger/dist/trustledger-standalone.html";

describe("T-65.3 docs: the ZERO-INSTALL pilot path (trustledger-standalone.html)", function () {
  let tl, tlLower, pilotDoc, pilotDocLower, adopt, goLive, goLiveLower, pilotReadme, strategy;

  before(function () {
    tl = read("docs/TRUSTLEDGER.md");
    tlLower = tl.toLowerCase();
    pilotDoc = read("docs/PILOT.md");
    pilotDocLower = pilotDoc.toLowerCase();
    adopt = read("docs/ADOPT.md");
    goLive = read("docs/GO-LIVE.md");
    goLiveLower = goLive.toLowerCase();
    pilotReadme = read("pilot/README.md");
    strategy = read("STRATEGY.md");
  });

  // -----------------------------------------------------------------------------------------------
  // The referenced artifacts exist — the prose can't point at vapor.
  // -----------------------------------------------------------------------------------------------
  describe("the referenced artifacts exist", function () {
    it("the shipped offline app + sidecar + provenance exist", function () {
      expect(exists(BUNDLE_REL), BUNDLE_REL).to.equal(true);
      expect(exists(BUNDLE_REL + ".sha256"), BUNDLE_REL + ".sha256").to.equal(true);
      expect(exists("trustledger/dist/BUILD-PROVENANCE.json"), "BUILD-PROVENANCE.json").to.equal(true);
    });

    it("the deterministic builder + the pinning test the docs cite exist", function () {
      expect(exists("trustledger/build-standalone.js"), "trustledger/build-standalone.js").to.equal(true);
      expect(exists("test/trustledger.standalone.test.js"), "test/trustledger.standalone.test.js").to.equal(true);
    });
  });

  // -----------------------------------------------------------------------------------------------
  // docs/TRUSTLEDGER.md — the "Zero-install: the offline app" section.
  // -----------------------------------------------------------------------------------------------
  describe("docs/TRUSTLEDGER.md — Zero-install: the offline app", function () {
    it("carries the section and NAMES the file", function () {
      expect(tl).to.match(/^##+ .*Zero-install: the offline app/m);
      expect(tl).to.include("trustledger-standalone.html");
      expect(tl).to.include("trustledger/dist/trustledger-standalone.html");
    });

    it("describes the one-emailed-file flow: email ONE file / USB stick / double-click", function () {
      expect(tlLower).to.match(/email[\s\S]{0,80}one file|one file[\s\S]{0,80}email/i);
      expect(tlLower).to.include("usb stick");
      expect(tlLower).to.include("double-click");
      // No install, no server, no terminal — the zero-install claim itself.
      expect(tlLower).to.match(/no install|nothing to install/);
    });

    it("describes the drag-drop THREE-file flow (bank / ledger / rent roll) to the same tie-out report", function () {
      expect(tlLower).to.match(/drag/);
      expect(tlLower).to.match(/bank statement/);
      expect(tlLower).to.match(/quickbooks|trust ledger/);
      expect(tlLower).to.match(/rent.?roll/);
      // ... and what they read at the end: the same tie-out report / audit packet.
      expect(tlLower).to.match(/tie-?out/);
      expect(tlLower).to.match(/pass\/fail verdict/);
    });

    it("frames the offline surface HONESTLY: two INDEPENDENT monthly tie-outs, roll-forward stays CLI-only", function () {
      const N = norm(tl);
      // The sharpened-P-5 framing: month-1 + month-2 real files, with zero install.
      expect(tl).to.match(/month.?1/i);
      expect(tl).to.match(/month.?2/i);
      expect(tl).to.match(/two-month/i);
      // It is wired into the sharpened P-5 ask, not a new ask.
      expect(tl).to.match(/sharpened P-5 ask/i);

      // HONEST framing (the T-65.3 rework): the free zero-install surface is two INDEPENDENT
      // monthly tie-outs, NOT the machine-checked roll-forward — the app runs each month on its own.
      expect(N, "names two INDEPENDENT monthly tie-outs on real data").to.include(
        "two INDEPENDENT monthly tie-outs on real data"
      );
      expect(N, "each month is an independent single-month reconcile").to.include(
        "independent single-month reconcile"
      );

      // The continuity boundary CANNOT rot: the doc must say WHY the offline app can't roll forward
      // (no prior-close input / no close-download in the UI), and that the --emit-close / --prior-close
      // continuity chain — the no-CONTINUITY_BREAK check — lives ONLY in the installed CLI and is
      // NOT part of the free zero-install surface.
      expect(tl).to.include("--prior-close");
      expect(tl).to.include("--emit-close");
      expect(tl).to.include("CONTINUITY_BREAK");
      expect(N, "the UI has no prior-close input / no close-download").to.include(
        "no prior-close input and no close-download"
      );
      expect(N, "the close chain lives ONLY in the installed CLI").to.include(
        "only in the installed product's CLI"
      );
      expect(N, "the continuity chain is NOT part of the free zero-install surface").to.include(
        "NOT part of the free zero-install surface"
      );

      // The byte-identity claim is pinned by the T-65.2 suite, named in the doc — AND the doc is
      // explicit that the pin is at the ENGINE / PAYLOAD level, NOT that the app's UI delivers it.
      expect(tl).to.include("test/trustledger.standalone.test.js");
      expect(N, "the pin is at the payload level").to.include("payload level");
      expect(N, "the pin does NOT mean the app's UI delivers the roll-forward").to.include(
        "mean the offline app's UI delivers it"
      );
    });

    it("states the no-network privacy claim HONESTLY and VERIFIABLY (devtools; no network API)", function () {
      expect(tlLower).to.match(/no network request/);
      expect(tlLower).to.match(/contains no network api/);
      expect(tlLower).to.match(/devtools network tab/);
      expect(tlLower).to.match(/never leaves the machine/);
      // The named tokens whose absence IS the claim.
      for (const tok of ["fetch(", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "import("]) {
        expect(tl, `docs name the absent token ${tok}`).to.include(tok);
      }
      // The recipient-side integrity check.
      expect(tl).to.include("sha256sum -c trustledger-standalone.html.sha256");
    });

    it("carries the honesty boundary VERBATIM + the reused (never weakened) gate refusals", function () {
      expect(norm(tl)).to.include(norm(BOUNDARY_VERBATIM));
      expect(tl).to.include("license_required");
      expect(tl).to.include("license_invalid");
      expect(tlLower).to.match(/installed product/);
      expect(tlLower).to.match(/never\s+weakened/);
    });

    it("wires the zero-install variant into the P-5 two-month step WITHOUT changing the human steps", function () {
      // The 'What stays a human step' section gains the amendment...
      expect(tl).to.match(/or hand them the offline app/i);
      // ...and explicitly re-states that P-5 #1/#2/#3 stay the human steps.
      expect(tl).to.include("P-5 #1");
      expect(tl).to.include("P-5 #2");
      expect(tl).to.include("P-5 #3");
    });
  });

  // -----------------------------------------------------------------------------------------------
  // docs/PILOT.md — the "Zero-install: the offline app" section.
  // -----------------------------------------------------------------------------------------------
  describe("docs/PILOT.md — Zero-install: the offline app", function () {
    it("carries the section and NAMES the file", function () {
      expect(pilotDoc).to.match(/^###+ .*Zero-install: the offline app/m);
      expect(pilotDoc).to.include("trustledger-standalone.html");
      expect(pilotDoc).to.include("trustledger/dist/trustledger-standalone.html");
    });

    it("describes the flow: email ONE file / USB / double-click / drag the three REAL exports / read the tie-out", function () {
      expect(pilotDocLower).to.match(/email[\s\S]{0,80}one file|one file[\s\S]{0,80}email/i);
      expect(pilotDocLower).to.include("usb stick");
      expect(pilotDocLower).to.include("double-click");
      expect(pilotDocLower).to.match(/drag/);
      expect(pilotDocLower).to.match(/bank statement/);
      expect(pilotDocLower).to.match(/quickbooks|trust ledger/);
      expect(pilotDocLower).to.match(/rent.?roll/);
      expect(pilotDocLower).to.match(/tie-?out/);
    });

    it("frames the offline surface HONESTLY: two INDEPENDENT monthly tie-outs, continuity stays CLI-only", function () {
      const N = norm(pilotDoc);
      expect(pilotDoc).to.match(/month-?1/i);
      expect(pilotDoc).to.match(/month-?2/i);
      expect(pilotDoc).to.match(/two-month/i);
      expect(pilotDocLower).to.match(/prior-close/);
      expect(pilotDocLower).to.match(/willingness-to-pay|wtp/);
      expect(pilotDoc).to.include("test/trustledger.standalone.test.js");
      expect(pilotDoc).to.match(/sharpened P-5 ask/i);

      // HONEST framing (T-65.3 rework): two INDEPENDENT monthly tie-outs, not a roll-forward.
      expect(N, "names two INDEPENDENT monthly tie-outs on real data").to.include(
        "two INDEPENDENT monthly tie-outs on real data"
      );

      // The continuity boundary can't rot: the machine-checked roll-forward (no CONTINUITY_BREAK via
      // --emit-close / --prior-close) is NOT in the offline app; it stays an installed-CLI capability.
      expect(pilotDoc).to.include("CONTINUITY_BREAK");
      expect(pilotDoc).to.include("--emit-close");
      expect(N, "the offline app is named as the surface the roll-forward is NOT in").to.include(
        "in the offline app"
      );
      expect(N, "the roll-forward stays an installed-CLI capability").to.include("installed-CLI");
      expect(
        N,
        "the continuity roll-forward is tied to the installed-CLI-only boundary"
      ).to.match(/machine-checked continuity roll-forward[\s\S]{0,240}installed-CLI/i);

      // The pin is engine/payload-level, NOT that the app's UI delivers it.
      expect(N, "the pin is at the payload level").to.include("payload level");
      expect(N, "the pin does NOT mean the app's UI delivers the roll-forward").to.include(
        "not that the app's UI delivers it"
      );
    });

    it("states the no-network privacy claim honestly and verifiably", function () {
      expect(pilotDocLower).to.match(/no network request/);
      expect(pilotDocLower).to.match(/contains no network api/);
      expect(pilotDocLower).to.match(/devtools network tab/);
      expect(pilotDocLower).to.match(/never leaves their machine|never leaves the machine/);
      expect(pilotDoc).to.include("sha256sum -c trustledger-standalone.html.sha256");
    });

    it("carries the honesty boundary VERBATIM and points at the deeper spec", function () {
      expect(norm(pilotDoc)).to.include(norm(BOUNDARY_VERBATIM));
      expect(pilotDoc).to.include("license_required");
      // Points the reader at the full section in TRUSTLEDGER.md.
      expect(pilotDoc).to.match(/TRUSTLEDGER\.md[^\n]*Zero-install/);
    });
  });

  // -----------------------------------------------------------------------------------------------
  // The one-line pointers: ADOPT.md, GO-LIVE.md's pilot-fallback paragraph, pilot/README.md.
  // -----------------------------------------------------------------------------------------------
  describe("the pointers (ADOPT.md / GO-LIVE.md pilot-fallback / pilot/README.md)", function () {
    it("docs/ADOPT.md points at the zero-install offline app", function () {
      expect(adopt).to.include("trustledger-standalone.html");
      expect(adopt).to.match(/Zero-install: the offline app/);
      expect(adopt.toLowerCase()).to.match(/no network request/);
      // Honest tier framing survives even in the pointer.
      expect(adopt.toLowerCase()).to.match(/free tier only/);
    });

    it("docs/GO-LIVE.md carries the pilot-fallback paragraph with the pointer", function () {
      expect(goLiveLower).to.match(/fallback/);
      expect(goLive).to.include("P-5");
      expect(goLive).to.include("trustledger-standalone.html");
      expect(goLive).to.match(/Zero-install: the offline app/);
      // The fallback paragraph must not relax the human gate it points into.
      expect(goLiveLower).to.match(/human-owned and\s+unchanged|stays human-owned|human-owned[\s\S]{0,40}unchanged/);
    });

    it("pilot/README.md points the operator at the zero-install path", function () {
      expect(pilotReadme).to.include("trustledger-standalone.html");
      expect(pilotReadme).to.match(/Zero-install/);
      expect(pilotReadme.toLowerCase()).to.match(/no network\s+request/);
      expect(pilotReadme.toLowerCase()).to.match(/double-click/);
    });
  });

  // -----------------------------------------------------------------------------------------------
  // The no-network claim is a property of the SHIPPED FILE, not prose: re-scan the committed dist
  // bundle for the same token list test/trustledger.standalone.test.js pins. If the bundle ever
  // grows a network API, the docs' privacy claim above fails HERE too — the prose cannot outlive
  // the property it advertises.
  // -----------------------------------------------------------------------------------------------
  describe("the docs' no-network claim is anchored to the shipped bytes", function () {
    it(`the committed ${BUNDLE_REL} contains NO network-API token`, function () {
      const bundle = read(BUNDLE_REL);
      expect(bundle.length, "bundle is non-trivial").to.be.greaterThan(10000);
      for (const tok of NETWORK_TOKENS) {
        expect(bundle.includes(tok), `bundle must not contain ${JSON.stringify(tok)}`).to.equal(false);
      }
    });
  });

  // -----------------------------------------------------------------------------------------------
  // The P-line grep (task (d)): NO P-3 / P-5 / P-6 / P-8 / P-9 human step was deleted or relaxed.
  // Each proposal block is anchored INSIDE the `## Proposals — needs-human` section and bounded at
  // the next top-level proposal bullet, then grepped for its needs-human status, its key human
  // steps, and its "the loop must not do this" language.
  // -----------------------------------------------------------------------------------------------
  describe("the P-line grep — no human step deleted or relaxed (STRATEGY.md)", function () {
    function proposalBlock(id) {
      const header = strategy.search(/##\s*Proposals — needs-human/);
      expect(header, "needs-human proposals section present").to.be.greaterThan(-1);
      const start = strategy.indexOf(`- **${id} (`, header);
      expect(start, `${id} proposal present in the needs-human section`).to.be.greaterThan(-1);
      const tail = strategy.slice(start + 4);
      const next = tail.search(/\n- \*\*P-\d+ \(/);
      return next === -1 ? strategy.slice(start) : strategy.slice(start, start + 4 + next);
    }

    it("P-3 (trust-root) still stands: needs-human, key custody stays out of the loop", function () {
      const block = proposalBlock("P-3");
      expect(block).to.include("needs-human");
      expect(block).to.match(/trust.?root/i);
      expect(norm(block)).to.include("the loop must NOT stand this up on its own");
    });

    it("P-5 (TrustLedger legal/CPA/design-partner) still carries ALL THREE human steps, unrelaxed", function () {
      const block = proposalBlock("P-5");
      expect(block).to.include("needs-human");
      expect(block).to.match(/MUST NOT be auto-executed/);
      // Step 1 — CPA/counsel sign-off on the disclaimer + the meaning of PASS.
      expect(block).to.match(/CPA \/ counsel sign-off/);
      // Step 2 — the per-state policy table, counsel-signed.
      expect(block).to.match(/per-state policy TABLE/);
      // Step 3 — the two-month design-partner script (the WTP validation).
      expect(block).to.match(/two-month design-partner SCRIPT/);
      expect(norm(block)).to.match(/must NOT auto-resolve any of \(1\)[–-]\(3\)/);
    });

    it("P-6 (vendor key / price / license issuance) still carries its three human steps, unrelaxed", function () {
      const block = proposalBlock("P-6");
      expect(block).to.include("needs-human");
      expect(block).to.match(/MUST NOT be auto-executed/);
      expect(block).to.match(/VENDOR keypair/i);
      expect(block).to.match(/Pick the PRICE/);
      expect(block).to.match(/Issue a signed license to each PAYING customer/);
    });

    it("P-8 (consolidated go-to-market ask) still stands: needs-human, land the partner + run the pilot", function () {
      const block = proposalBlock("P-8");
      expect(block).to.include("needs-human");
      expect(block).to.match(/MUST NOT be auto-executed/);
      expect(block).to.match(/design partner/i);
      expect(block).to.match(/run the pilot/i);
    });

    it("P-9 (SDK distribution + pricing) still stands: needs-human, publish + price stay human", function () {
      const block = proposalBlock("P-9");
      expect(block).to.include("needs-human");
      expect(block).to.match(/MUST NOT be auto-executed/);
      expect(block).to.match(/publish/i);
      expect(block).to.match(/pric(e|ing)/i);
    });

    it("the boundary sentence itself promises NO new needs-human item — and the docs add none", function () {
      // The verbatim boundary (pinned above in both docs) states "(no new needs-human item, no
      // relaxed gate)". Tripwire: the T-65.3 docs surfaces must not themselves smuggle in a NEW
      // needs-human PROPOSAL — 'needs-human' may appear in these docs only as prose about the
      // EXISTING human steps, never as a new "Status: needs-human" proposal block.
      for (const [rel, text] of [
        ["docs/TRUSTLEDGER.md", tl],
        ["docs/PILOT.md", pilotDoc],
        ["docs/ADOPT.md", adopt],
        ["docs/GO-LIVE.md", goLive],
        ["pilot/README.md", pilotReadme],
      ]) {
        expect(text, `${rel} must not declare a new needs-human proposal`).to.not.match(
          /\*Status:\s*needs-human/
        );
      }
    });
  });
});

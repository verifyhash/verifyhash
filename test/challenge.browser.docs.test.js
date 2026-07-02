"use strict";

// ---------------------------------------------------------------------------
// T-66.3 docs-rot guard for the LINK-SHAPED first contact (the browser challenge page).
//
// PURE (no chain, no spawns, no writes): T-66.2 shipped verifier/dist/verify-vh-standalone.html — the
// 60-second challenge as ONE committed, fully offline HTML file. THIS suite proves the funnel actually
// ROUTES a cold prospect at it, honestly, and that the wiring can never silently rot:
//
//   * challenge/README.md gains a "No Node? Do it in your browser" path at the TOP of the flow (the
//     node path stays as the CI-shaped variant);
//   * docs/ADOPT.md, docs/PILOT.md (the doc the P-8 ask hands a prospect), docs/INDEPENDENT-VERIFICATION.md,
//     and verifier/README.md each carry a pointer section naming the page;
//   * every routed surface pins the SAME five honest facts: the file name, the sample-then-tamper flow
//     (load sample -> ACCEPT; change one character -> REJECT naming the file), the no-network/devtools
//     claim, the page's boundary sentence VERBATIM (challenge + verifier README carry it in full), and
//     the "for CI/production gating use the node standalone" caveat;
//   * the page enters the PUBLISHED site set (site/publish-set.json + the committed RELEASE-MANIFEST
//     twin) and the landing page links it;
//   * and NO P-3/P-5/P-6/P-7/P-8/P-9 human step was deleted or relaxed: each proposal still sits in
//     STRATEGY.md's needs-human section with its needs-human status, and none of the edited docs'
//     page mentions smuggles in a needs-human escalation or re-sharpens a proposal.
//
// The PAGE's behavior (byte-reproducible build, DOM-free engine, verdict parity, the six-token
// no-network grep) is proved by test/verifier.standalone-html.test.js; THIS suite proves the PROSE
// that routes people at it matches that behavior.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// Whitespace-collapsed view so phrases that WRAP across markdown lines (incl. `>` blockquote markers)
// match a single-space string — we pin the prose meaning, not its line-wrapping.
const flatten = (s) => s.replace(/\s*\n\s*>?\s*/g, " ").replace(/\s+/g, " ");
// Tag-stripped + flattened view of HTML, so the page's own prose can be compared to markdown prose.
const stripHtml = (s) => flatten(s.replace(/<[^>]+>/g, " "));

const PAGE_NAME = "verify-vh-standalone.html";
const PAGE_REL = "verifier/dist/verify-vh-standalone.html";
const SIDECAR_REL = "verifier/dist/verify-vh-standalone.html.sha256";

// The boundary sentence the page carries (T-66.2 acceptance d) — the docs that route a prospect at the
// page must never claim MORE than this. Pinned against the committed page below, so "verbatim" is a
// real cross-check, not a hand-copied literal.
const BOUNDARY_VERBATIM =
  "ACCEPT is tamper-evidence that these exact bytes match the seal — and, for a signed seal, WHO " +
  "vouched (signer recovery + optional vendor pin). It is NOT a trusted timestamp and NOT proof of " +
  "WHEN without the P-3 trust-root.";
const CI_CAVEAT = "For CI/production gating use the node standalone";

// The five honest facts EVERY routed pointer section must carry (checked on the flattened,
// lowercased section text).
function assertPointerSection(name, section) {
  const f = flatten(section).toLowerCase();
  expect(f, `${name}: names the page file`).to.include(PAGE_NAME);
  expect(f, `${name}: frames the browser (no-terminal) path`).to.match(/browser/);
  expect(f, `${name}: the sample verifies -> ACCEPT`).to.match(/accept/);
  expect(f, `${name}: change one character/byte`).to.match(/one (character|byte)/);
  expect(f, `${name}: then REJECT`).to.match(/reject/);
  expect(f, `${name}: REJECT is localized (names the file)`).to.match(/nam(e|es|ing) the file|the file (you )?changed/);
  expect(f, `${name}: the no-network claim`).to.match(/no network api/);
  expect(f, `${name}: the claim is checkable in devtools`).to.match(/devtools network tab/);
  expect(f, `${name}: the CI-use-the-node-standalone caveat`).to.include(CI_CAVEAT.toLowerCase());
}

// sectionFrom(doc, anchor) -> the doc slice from the anchor heading to the next heading of the same or
// higher markdown level (or EOF). Throws a readable failure if the anchor is missing.
function sectionFrom(doc, anchor, name) {
  const at = doc.indexOf(anchor);
  expect(at, `${name}: anchor ${JSON.stringify(anchor)} must exist`).to.be.greaterThan(-1);
  const level = (anchor.match(/^#+/) || ["##"])[0].length;
  const re = new RegExp(`\\n#{1,${level}} `, "g");
  re.lastIndex = at + anchor.length;
  const m = re.exec(doc);
  return doc.slice(at, m ? m.index : doc.length);
}

describe("T-66.3 docs: the browser challenge page is wired into the funnel, honestly", function () {
  let page, pageFlat;
  let challenge, challengeFlat;
  let adopt, pilot, indep, verifierReadme;
  let strategy;

  before(function () {
    page = read(PAGE_REL);
    pageFlat = stripHtml(page);
    challenge = read("challenge/README.md");
    challengeFlat = flatten(challenge);
    adopt = read("docs/ADOPT.md");
    pilot = read("docs/PILOT.md");
    indep = read("docs/INDEPENDENT-VERIFICATION.md");
    verifierReadme = read("verifier/README.md");
    strategy = read("STRATEGY.md");
  });

  // -----------------------------------------------------------------------
  // The SOURCE first: the committed page really is what the docs say it is. If the page's boundary or
  // no-network prose ever changes, this pins fail FIRST, forcing the docs to move in lock-step.
  // -----------------------------------------------------------------------
  describe("the committed page is the canonical source the docs quote", function () {
    it("the page + its sha256 sidecar exist and agree", function () {
      const bytes = fs.readFileSync(path.join(ROOT, PAGE_REL));
      const sidecar = read(SIDECAR_REL);
      expect(sidecar).to.equal(`${sha256(bytes)}  ${PAGE_NAME}\n`);
    });

    it("the page carries the boundary sentence + CI caveat VERBATIM (the string the docs restate)", function () {
      expect(pageFlat, "boundary sentence on the page").to.include(BOUNDARY_VERBATIM);
      expect(pageFlat, "CI caveat on the page").to.include(CI_CAVEAT);
    });

    it("the page carries the sample-then-tamper controls and the devtools/no-network claim", function () {
      expect(page).to.include('id="load-sample"');
      expect(page).to.include('id="sample-tamper"');
      expect(page).to.include("devtools Network tab");
    });
  });

  // -----------------------------------------------------------------------
  // (a) challenge/README.md: the browser path is at the TOP of the flow; node stays the CI variant.
  // -----------------------------------------------------------------------
  describe("challenge/README.md leads with the browser path (node stays the CI-shaped variant)", function () {
    const HEADING = "## No Node? Do it in your browser";

    it("has the browser section BEFORE the node three-command flow", function () {
      const browserAt = challenge.indexOf(HEADING);
      const nodeAt = challenge.indexOf("## Do it now (three commands)");
      expect(browserAt, "browser section exists").to.be.greaterThan(-1);
      expect(nodeAt, "the node flow is KEPT").to.be.greaterThan(-1);
      expect(browserAt, "browser path sits at the TOP of the flow").to.be.lessThan(nodeAt);
      // The node path is still fully wired (the CI-shaped variant is not demoted to prose).
      expect(challenge).to.match(/run\.sh/);
      expect(challenge).to.match(/verify-vh-standalone\.js/);
    });

    it("the browser section carries all five honest facts", function () {
      assertPointerSection("challenge/README.md", sectionFrom(challenge, HEADING, "challenge/README.md"));
    });

    it("restates the page's boundary sentence VERBATIM", function () {
      expect(challengeFlat, "challenge/README.md carries the page boundary verbatim").to.include(BOUNDARY_VERBATIM);
    });

    it("is honest the sample is the SAME committed demo packet through the SAME engine (no forked demo)", function () {
      const f = challengeFlat.toLowerCase();
      expect(f).to.match(/same committed demo packet/);
      expect(f).to.match(/same engine/);
      // …and the page itself is reproducible from source, like every other shipped bundle.
      expect(challenge).to.include("node verifier/build-standalone-html.js --check");
    });
  });

  // -----------------------------------------------------------------------
  // (b) the four funnel docs each carry a pointer section. docs/PILOT.md is the doc the P-8 ask hands
  // the prospect, so the link-shaped path lands in the ask's own reading path WITHOUT editing STRATEGY.md.
  // -----------------------------------------------------------------------
  describe("the funnel docs route at the page (ADOPT / PILOT / INDEPENDENT-VERIFICATION / verifier README)", function () {
    it("docs/ADOPT.md: the no-terminal row + section", function () {
      expect(adopt, "the adopt table's browser row").to.match(/verify in your browser/i);
      assertPointerSection(
        "docs/ADOPT.md",
        sectionFrom(adopt, "## 0. The no-terminal path", "docs/ADOPT.md")
      );
    });

    it("docs/PILOT.md: the link-shaped first contact section (the P-8 ask's reading path)", function () {
      const sec = sectionFrom(pilot, "### The link-shaped first contact", "docs/PILOT.md");
      assertPointerSection("docs/PILOT.md", sec);
      // It is honest about deployment: the page is in the PUBLISH SET; uploading stays human-owned.
      expect(flatten(sec).toLowerCase()).to.match(/publish set/);
      expect(flatten(sec).toLowerCase()).to.match(/human-owned deploy step/);
    });

    it("docs/PILOT.md §6: the P-8 ask's first contact is now link-shaped — and the ask itself is unchanged", function () {
      const sec = sectionFrom(pilot, "## 6. The single go-to-market ask (P-8)", "docs/PILOT.md §6");
      const f = flatten(sec).toLowerCase();
      expect(f, "§6 names the link-shaped first contact").to.match(/link-shaped/);
      expect(f, "§6 names the page").to.include(PAGE_NAME);
      expect(f, "§6 keeps the human steps human").to.match(/human step(s)? .*(stay|remain)|stays? human-owned/);
    });

    it("docs/INDEPENDENT-VERIFICATION.md: the browser blockquote next to the challenge pointer", function () {
      assertPointerSection(
        "docs/INDEPENDENT-VERIFICATION.md",
        sectionFrom(indep, "> **No Node on the machine? Run that challenge in your browser.**", "docs/INDEPENDENT-VERIFICATION.md")
      );
    });

    it("verifier/README.md: §0y, carrying the boundary VERBATIM like the challenge doc", function () {
      const sec = sectionFrom(verifierReadme, "## 0y. No Node at all?", "verifier/README.md");
      assertPointerSection("verifier/README.md", sec);
      expect(flatten(sec), "verifier/README.md §0y restates the boundary verbatim").to.include(BOUNDARY_VERBATIM);
    });
  });

  // -----------------------------------------------------------------------
  // (c) the page is in the PUBLISHED site set + landing page (T-67.1 wiring, same pass).
  // -----------------------------------------------------------------------
  describe("the page enters the published site set + landing page", function () {
    it("site/publish-set.json maps the page AND its sha256 sidecar to the committed dist", function () {
      const set = JSON.parse(read("site/publish-set.json"));
      expect(set.publish[PAGE_NAME]).to.equal(PAGE_REL);
      expect(set.publish[`${PAGE_NAME}.sha256`]).to.equal(SIDECAR_REL);
    });

    it("the committed site/RELEASE-MANIFEST.json twin already carries the page at the committed bytes", function () {
      const manifest = JSON.parse(read("site/RELEASE-MANIFEST.json"));
      const entry = (manifest.files || []).find((f) => f.path === PAGE_NAME);
      expect(entry, "RELEASE-MANIFEST.json lists the page — re-run `node scripts/site-release.js`").to.be.an("object");
      expect(entry.sha256, "manifest pins the committed page bytes").to.equal(
        sha256(fs.readFileSync(path.join(ROOT, PAGE_REL)))
      );
    });

    it("the landing page links the page + sidecar and keeps the honest caveat", function () {
      const landing = read("site/index.html");
      expect(landing).to.include(`href="/${PAGE_NAME}"`);
      expect(landing).to.include(`href="/${PAGE_NAME}.sha256"`);
      const f = flatten(landing).toLowerCase();
      expect(f, "landing copy keeps the no-network claim").to.match(/no network api/);
      expect(f, "landing copy keeps the CI caveat").to.match(/ci\/production gating use the node standalone/);
    });
  });

  // -----------------------------------------------------------------------
  // (d) NOTHING was relaxed: every P-3/P-5/P-6/P-7/P-8/P-9 human step still stands, and the new
  // routing prose escalates nothing.
  // -----------------------------------------------------------------------
  describe("no P-3/P-5/P-6/P-7/P-8/P-9 human step was deleted or relaxed", function () {
    it("each proposal still sits in STRATEGY.md's needs-human section with its needs-human status", function () {
      const header = strategy.search(/##\s*Proposals — needs-human/);
      expect(header, "the needs-human proposals section exists").to.be.greaterThan(-1);
      const proposals = strategy.slice(header);
      for (const id of ["P-3", "P-5", "P-6", "P-7", "P-8", "P-9"]) {
        const start = proposals.indexOf(`- **${id} (`);
        expect(start, `${id} proposal block still exists`).to.be.greaterThan(-1);
        const next = proposals.slice(start + 4).search(/\n- \*\*P-\d+ \(/);
        const block = next === -1 ? proposals.slice(start) : proposals.slice(start, start + 4 + next);
        expect(block, `${id} still carries its needs-human status (not relaxed)`).to.match(/\*Status:\s*needs-human/);
      }
    });

    it("no page-mention line in any edited doc smuggles in a needs-human item or a foreign proposal", function () {
      for (const [name, text] of [
        ["challenge/README.md", challenge],
        ["docs/ADOPT.md", adopt],
        ["docs/PILOT.md", pilot],
        ["docs/INDEPENDENT-VERIFICATION.md", indep],
        ["verifier/README.md", verifierReadme],
        ["site/index.html", read("site/index.html")],
      ]) {
        for (const ln of text.split("\n")) {
          if (!ln.includes(PAGE_NAME)) continue;
          expect(/needs-human/i.test(ln), `${name}: page mention must not escalate: ${ln}`).to.equal(false);
          // The only proposal a page-mention line may ride is the standing P-3 boundary (exclude
          // EIP-191-style standard names — those are not verifyhash proposals).
          for (const p of ln.match(/(?<![A-Za-z])P-\d+/g) || []) {
            expect(p, `${name}: page mention may only ride P-3 (got ${p}): ${ln}`).to.equal("P-3");
          }
          expect(
            /\b(sharpen|sharpened|redefine|redefined|re-?sharpen|now reads|is updated to|amend)\b/i.test(ln),
            `${name}: page mention must not re-sharpen a proposal: ${ln}`
          ).to.equal(false);
        }
      }
    });

    it("the edited funnel docs declare NO new needs-human proposal", function () {
      for (const [name, text] of [
        ["challenge/README.md", challenge],
        ["docs/ADOPT.md", adopt],
        ["docs/PILOT.md", pilot],
        ["docs/INDEPENDENT-VERIFICATION.md", indep],
        ["verifier/README.md", verifierReadme],
      ]) {
        expect(text, `${name} must not declare a new needs-human proposal`).to.not.match(/\*Status:\s*needs-human/);
      }
    });
  });
});

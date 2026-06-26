"use strict";

// test/adopt.docs.test.js — the ANTI-DRIFT acceptance suite for the self-serve adoption funnel (T-55.3).
//
// WHY THIS TEST EXISTS
//   docs/ADOPT.md is the FIRST-CLASS, copy-paste "adopt in one line" path: a cold prospect runs ONE
//   command and is either watching the verifier work (`npx --yes verify-vh demo`) or gating their CI
//   (`uses: <owner>/<repo>/verifier/action@<ref>`). A copy-paste line that has rotted away from the real
//   tool is worse than no line — it sends the prospect a command that no longer works. So this suite does
//   NOT trust the prose; it PROVES, against the REAL sources, that:
//     * ADOPT.md contains the LITERAL `npx … demo` line, and that line names the verifier package's REAL
//       bin (`verify-vh`) and a REAL subcommand (`demo`) of verifier/verify-vh.js — not a stale name;
//     * ADOPT.md contains the LITERAL `uses: …/verifier/action@<ref>` line, and the path it embeds is the
//       ACTUAL on-disk location of the composite action.yml (verifier/action/) — not a stale path;
//     * the honest-boundary sentence ("tamper-evidence + signer-pin", NOT a trusted "sealed at T") is
//       present, so the funnel never over-promises;
//     * README.md links to docs/ADOPT.md (the funnel is discoverable from the front door);
//     * public/docs/ADOPT.md (the web mirror) carries the same literal lines (the two copies cannot
//       silently diverge).
//   The suite writes nothing and runs no network; it only reads the shipped files + verifier package.json.

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const ADOPT = path.join(REPO, "docs", "ADOPT.md");
const PUBLIC_ADOPT = path.join(REPO, "public", "docs", "ADOPT.md");
const README = path.join(REPO, "README.md");
const ACTION_YML = path.join(REPO, "verifier", "action", "action.yml");
const VERIFY_VH = path.join(REPO, "verifier", "verify-vh.js");
const VERIFIER_PKG = path.join(REPO, "verifier", "package.json");
// The paid producer surface the funnel must close to (T-55.3 rework): the seal/fulfill verbs the CLI
// actually exposes, and the bundled DRAFT evidence plan catalog whose plan ids the doc must name.
const VH_CLI = path.join(REPO, "cli", "vh.js");
const EVIDENCE_PLAN_CATALOG = path.join(
  REPO,
  "cli",
  "core",
  "fixtures",
  "evidence-plans",
  "baseline.json"
);

// ---------------------------------------------------------------------------------------------------
// Derive the EXPECTED adoption lines from the REAL sources, so this test guards against drift rather
// than re-asserting a hardcoded copy of the doc.
// ---------------------------------------------------------------------------------------------------

// The verifier package's bin name — the `npx <bin>` line must name THIS, not a stale package name.
const verifierBin = Object.keys(JSON.parse(fs.readFileSync(VERIFIER_PKG, "utf8")).bin)[0];

// The composite action's on-disk location, as a repo-relative POSIX path: the `uses: …@<ref>` line must
// embed THIS path. action.yml lives at <repo>/verifier/action/action.yml -> the action dir is
// "verifier/action".
const actionDirRel = path
  .relative(REPO, path.dirname(ACTION_YML))
  .split(path.sep)
  .join("/");

const EXPECTED_NPX_LINE = `npx --yes ${verifierBin} demo`;
const EXPECTED_USES_LINE = `uses: <owner>/<repo>/${actionDirRel}@<ref>`;

// The PAID producer surface the free→paid bridge points at (T-55.3 rework). These literal copy-paste
// lines must name verbs the CLI REALLY exposes and a plan id the bundled catalog REALLY contains — so a
// PAYING prospect is never sent at a verb or plan that does not exist.
const EXPECTED_PAID_SEAL_LINE = "vh evidence seal <dir> --sign --license <f> --vendor 0xYOU";
const EXPECTED_FULFILL_PREFIX = "vh evidence license fulfill --plan ";

// Pull the catalog's real plan ids; the funnel's `--plan <id>` example must name one of THESE verbatim.
const evidenceCatalog = JSON.parse(fs.readFileSync(EVIDENCE_PLAN_CATALOG, "utf8"));
const catalogPlanIds = (evidenceCatalog.plans || []).map((p) => p.planId);

describe("self-serve adoption funnel docs/ADOPT.md (T-55.3)", function () {
  it("ships docs/ADOPT.md and its public web mirror", function () {
    expect(fs.existsSync(ADOPT), "docs/ADOPT.md must be shipped").to.equal(true);
    expect(fs.existsSync(PUBLIC_ADOPT), "public/docs/ADOPT.md must be shipped").to.equal(true);
  });

  it("contains the LITERAL `npx … demo` line, and it names the verifier's real bin + subcommand", function () {
    const md = fs.readFileSync(ADOPT, "utf8");

    // 1. The literal copy-paste line is present.
    expect(md, `ADOPT.md must contain the literal "${EXPECTED_NPX_LINE}"`).to.contain(EXPECTED_NPX_LINE);

    // 2. NO-DRIFT: that line names the verifier package's ACTUAL bin (not a stale package name)…
    expect(verifierBin, "verifier package bin should be verify-vh").to.equal("verify-vh");

    // 3. …and `demo` is a REAL subcommand of the shipped verify-vh.js (not invented prose). We assert the
    //    CLI dispatches on a "demo" command — the same string the npx line tells the prospect to run.
    const cli = fs.readFileSync(VERIFY_VH, "utf8");
    expect(cli, "verify-vh.js must implement a `demo` subcommand").to.match(/["']demo["']/);
  });

  it("contains the LITERAL `uses: …/verifier/action@<ref>` line, and the path matches the real action.yml location", function () {
    const md = fs.readFileSync(ADOPT, "utf8");

    // 1. The composite action actually exists on disk where the line claims.
    expect(fs.existsSync(ACTION_YML), "verifier/action/action.yml must be shipped").to.equal(true);
    expect(actionDirRel, "the action dir must be verifier/action").to.equal("verifier/action");

    // 2. The literal one-line `uses:` adoption line is present and embeds that exact path.
    expect(md, `ADOPT.md must contain the literal "${EXPECTED_USES_LINE}"`).to.contain(EXPECTED_USES_LINE);

    // 3. NO-DRIFT cross-check: the action.yml itself advertises the SAME adoption path in its description,
    //    so the doc, the action, and the on-disk location all agree on one string.
    const yml = fs.readFileSync(ACTION_YML, "utf8");
    expect(yml, "action.yml should advertise the same /verifier/action@<ref> adoption path").to.match(
      /<owner>\/<repo>\/verifier\/action@<ref>/
    );
  });

  it("states the honest boundary (tamper-evidence + signer-pin, NOT a trusted timestamp)", function () {
    const md = fs.readFileSync(ADOPT, "utf8").toLowerCase();
    // The funnel must not over-promise: it proves tamper-evidence + signer-pin, NOT "sealed at time T".
    expect(md, "ADOPT.md must claim tamper-evidence + signer-pin").to.contain("tamper-evidence + signer-pin");
    expect(md, 'ADOPT.md must disclaim the trusted "sealed at T" timestamp').to.match(
      /not a trusted "sealed at t"|not[^\n]*trusted[^\n]*sealed/
    );
  });

  it("closes the funnel to revenue: the LITERAL paid producer line names a REAL CLI verb", function () {
    const md = fs.readFileSync(ADOPT, "utf8");

    // 1. The literal paid copy-paste line is present — the free rows dead-end at "I watched it work";
    //    THIS line is the one that becomes revenue, so the funnel must carry it verbatim.
    expect(md, `ADOPT.md must contain the literal paid line "${EXPECTED_PAID_SEAL_LINE}"`).to.contain(
      EXPECTED_PAID_SEAL_LINE
    );

    // 2. NO-DRIFT: `vh evidence seal` and its paid flags (--sign / --license / --vendor) are REAL verbs
    //    the CLI exposes — not invented prose. We assert against the CLI's own help text.
    const cli = fs.readFileSync(VH_CLI, "utf8");
    expect(cli, "cli/vh.js must expose `vh evidence seal`").to.contain("vh evidence seal");
    for (const flag of ["--sign", "--license", "--vendor"]) {
      expect(cli, `vh evidence seal's paid surface must accept ${flag}`).to.contain(flag);
    }
  });

  it("names a REAL evidence plan id that EXISTS in the bundled catalog (the paying prospect is not sent at vaporware)", function () {
    const md = fs.readFileSync(ADOPT, "utf8");

    // 1. The catalog actually has plans to name.
    expect(catalogPlanIds.length, "the bundled evidence plan catalog must define at least one plan").to.be.greaterThan(
      0
    );

    // 2. The literal `vh evidence license fulfill --plan <id>` line is present…
    expect(md, `ADOPT.md must contain the literal "${EXPECTED_FULFILL_PREFIX}<id>" line`).to.contain(
      EXPECTED_FULFILL_PREFIX
    );

    // 3. …and the plan id it names is one the catalog REALLY contains (no drift to a renamed/removed plan).
    const namedPlan = catalogPlanIds.find((id) => md.includes(`--plan ${id}`));
    expect(
      namedPlan,
      `ADOPT.md's fulfill example must name a plan id present in the catalog (${catalogPlanIds.join(", ")})`
    ).to.be.a("string");

    // 4. NO-DRIFT cross-check: `vh evidence license fulfill` is a REAL verb the CLI exposes.
    const cli = fs.readFileSync(VH_CLI, "utf8");
    expect(cli, "cli/vh.js must expose `vh evidence license fulfill`").to.contain(
      "vh evidence license fulfill"
    );
  });

  it("states the free-vs-paid line AND keeps price/key/sale a human step (revenue integrity)", function () {
    const md = fs.readFileSync(ADOPT, "utf8");
    const low = md.toLowerCase();

    // The funnel must be explicit about what costs money and what does not…
    expect(low, "ADOPT.md must label the paid producer surface").to.contain("paid");
    expect(low, "ADOPT.md must contrast it with the free surface").to.contain("free");

    // …and must keep the price/key/sale as HUMAN steps the loop never executes (guardrail 4 + revenue
    // integrity: the value is delivered software, never a token/coin/appreciating asset).
    expect(low, 'ADOPT.md must mark the price/key/sale a "human" step').to.contain("human");
    expect(low, "ADOPT.md must disclaim the loop sets a price").to.match(
      /sets no price|set no price|no price|loop sets/
    );
    expect(low, "ADOPT.md must disclaim issuing a token/security").to.match(
      /never from issuing a token|not a security|not a token/
    );
  });

  it("README.md links to docs/ADOPT.md (the funnel is reachable from the front door)", function () {
    const readme = fs.readFileSync(README, "utf8");
    // A real markdown link to the funnel doc — accept the (path) target in any link form.
    expect(readme, "README must link to docs/ADOPT.md").to.match(/\]\(docs\/ADOPT\.md\)/);
  });

  it("public/docs/ADOPT.md carries the SAME literal adoption lines (the mirror cannot diverge)", function () {
    const md = fs.readFileSync(PUBLIC_ADOPT, "utf8");
    expect(md, "public mirror must contain the npx line").to.contain(EXPECTED_NPX_LINE);
    expect(md, "public mirror must contain the uses: line").to.contain(EXPECTED_USES_LINE);
    // The revenue-closing lines must mirror too — the paid path is the highest-value line in the funnel,
    // so the web copy can never silently drop it.
    expect(md, "public mirror must contain the paid seal line").to.contain(EXPECTED_PAID_SEAL_LINE);
    expect(md, "public mirror must contain the fulfill line").to.contain(EXPECTED_FULFILL_PREFIX);
  });
});

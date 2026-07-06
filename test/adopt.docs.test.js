"use strict";

// test/adopt.docs.test.js — the ANTI-DRIFT acceptance suite for the self-serve adoption funnel (T-55.3).
//
// WHY THIS TEST EXISTS
//   docs/ADOPT.md is the FIRST-CLASS, copy-paste "adopt in one line" path: a cold prospect runs ONE
//   command and is either watching the verifier work (`npx --yes verify-vh demo`) or gating their CI
//   (`uses: verifyhash/verifyhash/verifier/action@<full-sha>`). A copy-paste line that has rotted away
//   from the real tool is worse than no line — it sends the prospect a command that no longer works. So
//   this suite does NOT trust the prose; it PROVES, against the REAL sources, that:
//     * ADOPT.md contains the LITERAL `npx … demo` line, and that line names the verifier package's REAL
//       bin (`verify-vh`) and a REAL subcommand (`demo`) of verifier/verify-vh.js — not a stale name;
//     * every adoption doc pins the `uses:` line to the REAL repository slug + a FULL 40-hex commit SHA
//       reachable from origin/main (T-73.1) — a drift back to the old `<owner>/<repo>@<ref>` placeholder,
//       a mutable `@main`, or a short ref FAILS — and the path it embeds is the ACTUAL on-disk location
//       of the composite action.yml (verifier/action/), not a stale path;
//     * the honest-boundary sentence ("tamper-evidence + signer-pin", NOT a trusted "sealed at T") is
//       present, so the funnel never over-promises;
//     * README.md links to docs/ADOPT.md (the funnel is discoverable from the front door);
//     * public/docs/ADOPT.md (the web mirror) carries the same literal lines (the two copies cannot
//       silently diverge).
//   The suite writes nothing and runs no network; it only reads the shipped files + verifier package.json.

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const ADOPT = path.join(REPO, "docs", "ADOPT.md");
const PUBLIC_ADOPT = path.join(REPO, "public", "docs", "ADOPT.md");
const README = path.join(REPO, "README.md");
const ACTION_README = path.join(REPO, "verifier", "action", "README.md");
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

// T-73.1: the copy-paste `uses:` line must be PINNED to this repository's REAL slug plus a FULL 40-hex
// commit SHA — never the old `<owner>/<repo>@<ref>` placeholder, never a mutable `@main`, never a short
// ref. A cold prospect must be able to paste the line UNEDITED, and the docs must tell adopters to
// re-pin to a SHA they trust. (The SHA itself is not hardcoded here — re-pinning is legitimate — but
// its SHAPE, the slug, cross-file agreement, and origin/main ancestry are all pinned below.)
const REAL_SLUG = "verifyhash/verifyhash";
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const EXPECTED_USES_RE = new RegExp(`uses: ${REAL_SLUG}/${actionDirRel}@[0-9a-f]{40}`);
// Every `<slug>/verifier/action@<ref>` occurrence, whatever the slug/ref shape — placeholders, branch
// names, and short refs all MATCH here and are then rejected by the shape assertions.
const USES_OCCURRENCE_RE = /([A-Za-z0-9._<>-]+\/[A-Za-z0-9._<>-]+)\/verifier\/action@([A-Za-z0-9._<>-]+)/g;

// The three committed adoption docs + the public web mirror + the composite action's OWN metadata that
// must all carry the pinned line. action.yml's `description:` is the GitHub Marketplace-facing summary —
// the first surface a stranger meets — so it is held to the SAME no-placeholder, real-slug + full-SHA
// pin as the prose docs (a broken `uses:` line there is the same front-door failure, relocated).
// NOTE: the re-pin-note sweep below indexes PINNED_DOCS[0] and PINNED_DOCS[2] by position, so any new
// entry must be APPENDED (never inserted before verifier/action/README.md) to keep those indices stable.
const PINNED_DOCS = [
  ["docs/ADOPT.md", ADOPT],
  ["README.md", README],
  ["verifier/action/README.md", ACTION_README],
  ["public/docs/ADOPT.md", PUBLIC_ADOPT],
  ["verifier/action/action.yml", ACTION_YML],
];

// The PAID producer surface the free→paid bridge points at (T-55.3 rework). These literal copy-paste
// lines must name verbs the CLI REALLY exposes and a plan id the bundled catalog REALLY contains — so a
// PAYING prospect is never sent at a verb or plan that does not exist.
// T-75.3: the license is verified against the CANONICAL vendor identity, so the copy-paste paid line no
// longer carries a --vendor (a caller --vendor can no longer re-pin the gate).
const EXPECTED_PAID_SEAL_LINE = "vh evidence seal <dir> --sign --license <f>";
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

  it("contains the PINNED `uses: verifyhash/verifyhash/verifier/action@<full-sha>` line, and the path matches the real action.yml location", function () {
    const md = fs.readFileSync(ADOPT, "utf8");

    // 1. The composite action actually exists on disk where the line claims.
    expect(fs.existsSync(ACTION_YML), "verifier/action/action.yml must be shipped").to.equal(true);
    expect(actionDirRel, "the action dir must be verifier/action").to.equal("verifier/action");

    // 2. The one-line `uses:` adoption line is present, embeds that exact path, and is pinned to the
    //    REAL slug + a FULL 40-hex commit SHA (a stranger pastes it unedited — no placeholder to edit).
    expect(md, `ADOPT.md must contain the pinned "uses: ${REAL_SLUG}/${actionDirRel}@<40-hex sha>" line`).to.match(
      EXPECTED_USES_RE
    );

    // 3. NO-DRIFT cross-check: the action.yml itself advertises the SAME pinned adoption line in its
    //    Marketplace-facing `description:` — the REAL slug + a FULL 40-hex SHA at the real action path,
    //    with NO `<owner>/<repo>` placeholder. This is the most-public front door; a stranger who lands
    //    on the Marketplace listing before the README must still get a `uses:` line that resolves as
    //    pasted. (A loosened substring match here previously let the placeholder persist unguarded.)
    const yml = fs.readFileSync(ACTION_YML, "utf8");
    expect(yml, "action.yml must not carry the <owner>/<repo> placeholder on the Marketplace surface").to.not.contain(
      "<owner>/<repo>"
    );
    expect(
      yml,
      `action.yml's description must pin "uses: ${REAL_SLUG}/${actionDirRel}@<40-hex sha>" (not the <owner>/<repo> placeholder)`
    ).to.match(EXPECTED_USES_RE);
  });

  it("pins the REAL slug + a FULL 40-hex commit SHA in EVERY adoption doc (placeholder / @main / short-ref drift FAILS)", function () {
    const refs = new Set();
    for (const [name, file] of PINNED_DOCS) {
      const md = fs.readFileSync(file, "utf8");

      // 1. The old copy-paste placeholder may never come back.
      expect(md, `${name} must not contain the <owner>/<repo> placeholder`).to.not.contain("<owner>/<repo>");

      // 2. Every `…/verifier/action@<ref>` occurrence uses the REAL slug and a FULL 40-hex SHA — so a
      //    drift back to a placeholder slug, a mutable `@main`, or a short ref fails by shape.
      const occurrences = [...md.matchAll(USES_OCCURRENCE_RE)];
      expect(occurrences.length, `${name} must carry at least one …/verifier/action@<ref> adoption line`).to.be.greaterThan(0);
      for (const [, slug, ref] of occurrences) {
        expect(slug, `${name}: the uses: slug must be the real repository slug`).to.equal(REAL_SLUG);
        expect(
          FULL_SHA_RE.test(ref),
          `${name}: the uses: ref must be a FULL 40-hex commit SHA (got "@${ref}" — no <ref> placeholder, no @main, no short ref)`
        ).to.equal(true);
        refs.add(ref);
      }
    }

    // 3. All docs pin the SAME SHA (a partial re-pin is drift too).
    expect([...refs].length, `all adoption docs must pin ONE identical SHA (found: ${[...refs].join(", ")})`).to.equal(1);

    // 4. The docs must tell adopters to re-pin to a SHA they trust (the supply-chain honesty note).
    for (const [name, file] of [PINNED_DOCS[0], PINNED_DOCS[2]]) {
      expect(fs.readFileSync(file, "utf8"), `${name} must tell adopters to re-pin to a SHA they trust`).to.match(/re-pin/i);
    }
  });

  it("the pinned SHA is reachable from origin/main (offline git ancestry; skips only when origin/main is absent)", function () {
    const md = fs.readFileSync(ADOPT, "utf8");
    const occurrence = [...md.matchAll(USES_OCCURRENCE_RE)][0];
    expect(occurrence, "ADOPT.md must carry a pinned uses: line").to.not.equal(undefined);
    const sha = occurrence[2];

    // Offline, read-only git: no fetch, no network — origin/main is the local remote-tracking ref.
    const probe = spawnSync("git", ["rev-parse", "--verify", "--quiet", "origin/main"], { cwd: REPO });
    if (probe.error || probe.status !== 0) {
      // Not a clone with origin/main (e.g. an exported tarball) — the shape/slug pins above still hold.
      this.skip();
      return;
    }
    const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"], { cwd: REPO });
    expect(
      ancestry.status,
      `the pinned SHA ${sha} must be reachable from origin/main (re-pin the docs to a commit that is)`
    ).to.equal(0);
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
    expect(md, "public mirror must contain the pinned uses: line").to.match(EXPECTED_USES_RE);
    // The revenue-closing lines must mirror too — the paid path is the highest-value line in the funnel,
    // so the web copy can never silently drop it.
    expect(md, "public mirror must contain the paid seal line").to.contain(EXPECTED_PAID_SEAL_LINE);
    expect(md, "public mirror must contain the fulfill line").to.contain(EXPECTED_FULFILL_PREFIX);
  });
});

// =====================================================================================================
// T-74.5 — the head-on "why not sha256sum + a signed git tag / cosign / Rekor?" answer, the ANCHORING
// reconciliation with the REAL 2026-07-03 Polygon mainnet deploy, and the vendor-pinned-by-default CI
// recipe. These pins keep three honesty properties from rotting:
//   (1) the comparison table (README + landing page + TRUST-BOUNDARIES) states the free tools'
//       strengths AS strengths (FIPS hashes, ecosystems, Rekor timestamps), states what verifyhash
//       adds, states what it does NOT do (keccak256 not FIPS; no trusted timestamp without the
//       anchor) — and NEVER claims the free tools "can't" do what they demonstrably can;
//   (2) docs/ANCHORING.md names the live contract while KEEPING the loop-never-deploys guardrail
//       sentence verbatim, and its own prose no longer says "until a human deploys" (the FROZEN
//       in-band receipt note is the one legitimate carrier of that clause — see the deploy-state
//       lint in test/docs-paved-road.test.js);
//   (3) docs/ADOPT.md's CI recipe leads with `vendor:` as the RECOMMENDED DEFAULT and labels the
//       tamper-only (no `vendor:`) form the WEAKER mode.
// =====================================================================================================

describe("T-74.5: the head-on comparison + the mainnet-reconciled anchoring story", function () {
  const TRUST_BOUNDARIES = path.join(REPO, "docs", "TRUST-BOUNDARIES.md");
  const ANCHORING = path.join(REPO, "docs", "ANCHORING.md");
  const SITE_INDEX = path.join(REPO, "site", "index.html");
  const FIXTURE_RECEIPT = path.join(REPO, "examples", "anchoring", "anchored-receipt.local.json");

  const MAINNET_ADDRESS = "0x77d8eF881D5aeEda64788968D13f9146fE1A609B";
  const DEPLOY_DATE = "2026-07-03";
  // The guardrail sentence the reconciliation must KEEP verbatim (acceptance clause 2).
  const GUARDRAIL_SENTENCE =
    "The loop itself still NEVER deploys, holds funds, or anchors publicly (see STRATEGY.md P-2/P-3).";

  const COMPARISON_HEADING = "## Why not just `sha256sum` + a signed git tag — or `cosign` + Rekor?";

  // Slice a markdown section: from its heading to the next same-level heading (or EOF).
  function markdownSection(text, heading, name) {
    const start = text.indexOf(heading);
    expect(start, `${name} must carry the section "${heading}"`).to.be.greaterThan(-1);
    const end = text.indexOf("\n## ", start + heading.length);
    return end === -1 ? text.slice(start) : text.slice(start, end);
  }

  // The landing page's comparison section: <section id="compare"> … </section>.
  function landingCompareSection(html) {
    const start = html.indexOf('<section id="compare">');
    expect(start, 'site/index.html must carry <section id="compare">').to.be.greaterThan(-1);
    const end = html.indexOf("</section>", start);
    expect(end, "the compare section must close").to.be.greaterThan(start);
    return html.slice(start, end);
  }

  // The three-row honesty pins, shared across every surface that carries the table.
  function assertHonestComparison(section, name) {
    const low = section.toLowerCase();
    // Row 1 — the free tools' strengths, stated AS strengths.
    for (const s of ["sha256sum", "cosign", "rekor", "fips 180-4", "transparency log", "inclusion timestamp", "mature ecosystems"]) {
      expect(low, `${name}: row 1 must credit the free tools ("${s}")`).to.contain(s);
    }
    expect(low, `${name}: row 1 must affirmatively recommend the free tools when they fit`).to.contain("use them");
    // Row 2 — what verifyhash adds.
    for (const s of ["one offline, single-file verifier", "no toolchain, no account, no ca", "signer-pin", "per-file tamper localization", "permissionless existence anchor"]) {
      expect(low, `${name}: row 2 must state what verifyhash adds ("${s}")`).to.contain(s);
    }
    // Row 3 — what verifyhash does NOT do.
    expect(low, `${name}: row 3 must state the timestamp boundary`).to.contain("no trusted timestamp without the anchor");
    expect(low, `${name}: row 3 must state keccak256 is not FIPS`).to.contain("keccak256 is not a fips-approved hash");
    // The honesty rule: NO claim the free tools "can't" do what they can — the section carries no
    // can't/cannot at all (verifyhash's own limits are phrased as "does NOT do").
    expect(section, `${name}: the comparison must never say "can't"/"cannot"`).to.not.match(/can['’]t|cannot/i);
  }

  it("README.md carries the three-row honest comparison table", function () {
    const readme = fs.readFileSync(README, "utf8");
    const section = markdownSection(readme, COMPARISON_HEADING, "README.md");
    // EXACTLY three table body rows (the header/divider rows carry no bold row label).
    const rows = section.split("\n").filter((l) => l.startsWith("| **What"));
    expect(rows.length, "README's comparison table must have exactly three rows").to.equal(3);
    assertHonestComparison(section, "README.md");
  });

  it("docs/TRUST-BOUNDARIES.md carries the SAME three-row table next to the full trust model", function () {
    const tb = fs.readFileSync(TRUST_BOUNDARIES, "utf8");
    const section = markdownSection(tb, COMPARISON_HEADING, "docs/TRUST-BOUNDARIES.md");
    const rows = section.split("\n").filter((l) => l.startsWith("| **What"));
    expect(rows.length, "TRUST-BOUNDARIES' comparison table must have exactly three rows").to.equal(3);
    assertHonestComparison(section, "docs/TRUST-BOUNDARIES.md");
  });

  it("the landing page (site/index.html) carries the three-row comparison too", function () {
    const html = fs.readFileSync(SITE_INDEX, "utf8");
    const section = landingCompareSection(html);
    const rows = section.match(/<tr>/g) || [];
    expect(rows.length, "the landing comparison table must have exactly three rows").to.equal(3);
    assertHonestComparison(section, "site/index.html");
  });

  it("docs/ANCHORING.md names the LIVE Polygon mainnet contract and the deploy date", function () {
    const doc = fs.readFileSync(ANCHORING, "utf8");
    expect(doc, "ANCHORING.md must name the live contract").to.contain(MAINNET_ADDRESS);
    expect(doc, "ANCHORING.md must date the human deploy").to.contain(DEPLOY_DATE);
    expect(doc).to.contain("Polygon mainnet (chain id 137)");
    // The reconciliation aims readers at the live address from BOTH ends of the doc: the up-front
    // callout and the Going-public section.
    const goingPublic = doc.slice(doc.indexOf("## Going public"));
    expect(goingPublic, "the Going-public section must carry the live address").to.contain(MAINNET_ADDRESS);
  });

  it("docs/ANCHORING.md KEEPS the loop-never-deploys/holds-funds guardrail sentence VERBATIM", function () {
    // Word-for-word verbatim; markdown line wraps normalize to single spaces (the sentence has always
    // wrapped across lines in the doc), but not one word may change.
    const flat = fs.readFileSync(ANCHORING, "utf8").replace(/\s+/g, " ");
    expect(flat, `ANCHORING.md must keep verbatim: "${GUARDRAIL_SENTENCE}"`).to.contain(GUARDRAIL_SENTENCE);
  });

  it("docs/ANCHORING.md's OWN prose drops the stale not-deployed clause (only the FROZEN in-band note may carry it)", function () {
    const doc = fs.readFileSync(ANCHORING, "utf8");
    const frozenNote = JSON.parse(fs.readFileSync(FIXTURE_RECEIPT, "utf8")).note;
    // The doc must still quote the frozen note byte-for-byte (receipts pin it; an edited note is the
    // named bad-receipt) …
    expect(doc, "the frozen in-band note must still be quoted byte-for-byte").to.contain(frozenNote);
    // … but OUTSIDE that quotation, the not-deployed clause is stale drift.
    const scrubbed = doc.split(frozenNote).join(" ");
    expect(scrubbed, "no not-deployed prose outside the frozen note").to.not.match(/until a human deploys/i);
    expect(scrubbed).to.not.contain("no receipt from this repo is worth anything publicly");
  });

  it("README.md's anchoring pointer names the live deploy instead of the stale not-deployed phrase", function () {
    const readme = fs.readFileSync(README, "utf8");
    expect(readme, "README must name the live contract").to.contain(MAINNET_ADDRESS);
    expect(readme).to.not.match(/until a human deploys/i);
  });

  it("ADOPT's CI recipe: `vendor:` is the RECOMMENDED DEFAULT, tamper-only labeled the WEAKER mode (doc + public mirror)", function () {
    for (const [name, file] of [
      ["docs/ADOPT.md", ADOPT],
      ["public/docs/ADOPT.md", PUBLIC_ADOPT],
    ]) {
      const md = fs.readFileSync(file, "utf8");
      // The yaml itself leads with the pinned vendor: line, marked as the recommended default.
      expect(md, `${name}: the vendor: line must be marked the RECOMMENDED DEFAULT`).to.match(
        /vendor: "0xYOUR_PRODUCER_SIGNER_ADDRESS"[^\n]*RECOMMENDED DEFAULT/
      );
      // Tamper-only (no vendor:) is explicitly the WEAKER mode, stated AFTER the recommended form.
      const vendorAt = md.search(/vendor: "0xYOUR_PRODUCER_SIGNER_ADDRESS"/);
      const weakerAt = md.indexOf("WEAKER, tamper-only mode");
      expect(weakerAt, `${name}: must label the no-vendor form the "WEAKER, tamper-only mode"`).to.be.greaterThan(-1);
      expect(weakerAt, `${name}: the weaker-mode label must follow the recommended vendor: form`).to.be.greaterThan(vendorAt);
      // The weaker mode stays honest about what it still does and when it is legitimate.
      expect(md, `${name}: the weaker mode must still be credited for tamper-evidence`).to.contain("it still catches tampered bytes");
      expect(md, `${name}: unsigned seals remain the one legitimate tamper-only case`).to.contain("genuinely unsigned");
    }
  });
});

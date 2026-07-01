"use strict";

// ---------------------------------------------------------------------------
// T-62.2 docs-rot guard for the REFERENCE self-serve fulfillment webhook.
//
// Pure (no chain, no CLI run): asserts docs/EVIDENCE.md documents the
// `vh fulfill-webhook` surface the way the code actually behaves, and carries
// the honesty boundary VERBATIM — so the buyer-/operator-facing prose can't
// silently drift from cli/fulfill-webhook-http.js + cli/core/fulfill-intake.js.
//
// The acceptance this pins (T-62.2 › c):
//   * docs/EVIDENCE.md NAMES `vh fulfill-webhook` and describes the
//     `--secret-env` / `--binding` / `--key-env`|`--key-file` / `--out` flow;
//   * it states the fail-closed + idempotent + loopback posture (unsigned/
//     forged/stale delivers nothing; a re-delivered event returns the SAME
//     license; binds 127.0.0.1 by default);
//   * it carries the honesty-boundary sentence + the revenue-integrity line
//     VERBATIM (the loop ships the reference handler + OFFLINE tests; the real
//     secret/key/deploy are human-owned; a license is an ACCESS credential,
//     NOT a token/coin/NFT);
//   * docs/GO-LIVE.md step 3 POINTS at `vh fulfill-webhook`.
//
// The guard imports the live http module + intake core so it fails loudly if a
// module (or its surface) is ever removed — an otherwise-hollow docs guard.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

// Import the live modules the docs describe (so a removed surface trips the guard).
const fw = require("../cli/fulfill-webhook-http");
const intake = require("../cli/core/fulfill-intake");

// The VERBATIM honesty-boundary sentences the doc MUST carry. Pinned here as the
// single source of truth for the docs-rot check; the doc must contain both.
const BOUNDARY_VERBATIM =
  "The loop ships this reference handler and its OFFLINE tests (a synthetic signing secret and an ephemeral `Wallet.createRandom()` vendor key); provisioning the REAL provider webhook secret, the REAL vendor key, and DEPLOYING the endpoint behind your own URL/TLS remain the human-owned steps.";

const REVENUE_INTEGRITY_VERBATIM =
  "A delivered license is an ACCESS credential for delivered software value — NOT a token/coin/NFT, and not tradeable.";

describe("T-62.2 docs: `vh fulfill-webhook` documented (docs/EVIDENCE.md + docs/GO-LIVE.md)", function () {
  let evidenceDoc;
  let goliveDoc;

  before(function () {
    evidenceDoc = read("docs/EVIDENCE.md");
    goliveDoc = read("docs/GO-LIVE.md");
  });

  it("the live modules still export the surface this guard pins against", function () {
    // A removed transport/flag/route would make the doc a lie; assert the surface exists.
    expect(fw).to.have.property("createServer").that.is.a("function");
    expect(fw).to.have.property("FULFILL_PATH", "/fulfill");
    expect(fw).to.have.property("DEFAULT_HOST", "127.0.0.1");
    expect(intake).to.have.property("verifyProviderSignature").that.is.a("function");
    expect(intake).to.have.property("validateEvidencePriceBinding").that.is.a("function");
    expect(intake).to.have.property("normalizeEvidenceEvent").that.is.a("function");
    expect(intake).to.have.property("intakeDedupKey").that.is.a("function");
  });

  it("docs/EVIDENCE.md NAMES `vh fulfill-webhook` and describes the --secret-env/--binding/--key/--out flow", function () {
    expect(evidenceDoc).to.include("vh fulfill-webhook");
    expect(evidenceDoc).to.include("--secret-env");
    expect(evidenceDoc).to.include("--binding");
    expect(evidenceDoc).to.include("--key-env");
    expect(evidenceDoc).to.include("--key-file");
    expect(evidenceDoc).to.include("--out");
    // The real pipeline seams (not a hand-wave).
    expect(evidenceDoc).to.include("verifyProviderSignature");
    expect(evidenceDoc).to.include("parseEvidenceEvent");
    expect(evidenceDoc).to.include("normalizeEvidenceEvent");
    expect(evidenceDoc).to.include("fulfillEvidenceOrder");
    // The route + the delivered artifact name.
    expect(evidenceDoc).to.match(/POST\s+\/fulfill/);
    expect(evidenceDoc).to.include(".vhlicense.json");
  });

  it("docs/EVIDENCE.md states the fail-closed + idempotent + loopback posture the code enforces", function () {
    const lower = evidenceDoc.toLowerCase();
    // fail-closed on unsigned/forged/stale.
    expect(lower).to.include("fail-closed");
    expect(lower).to.match(/unsigned/);
    expect(lower).to.match(/forged/);
    expect(lower).to.match(/stale/);
    // idempotent: a re-delivered event returns the SAME licenseId.
    expect(lower).to.include("idempotent");
    expect(lower).to.match(/same\s+`?licenseid`?/);
    // 200 { delivered, licenseId } on success.
    expect(evidenceDoc).to.match(/200\s*\{?\s*delivered/);
    // loopback by default.
    expect(evidenceDoc).to.include("127.0.0.1");
    expect(lower).to.include("loopback");
  });

  it("docs/EVIDENCE.md carries the honesty-boundary sentence + revenue-integrity line VERBATIM", function () {
    expect(evidenceDoc, "docs/EVIDENCE.md must carry the boundary sentence verbatim").to.include(
      BOUNDARY_VERBATIM
    );
    expect(evidenceDoc, "docs/EVIDENCE.md must carry the revenue-integrity line verbatim").to.include(
      REVENUE_INTEGRITY_VERBATIM
    );
  });

  it("docs/GO-LIVE.md step 3 POINTS at `vh fulfill-webhook` (the removed-last-code-step)", function () {
    expect(goliveDoc).to.include("vh fulfill-webhook");
    // A numbered step 3 exists and references the self-serve fulfillment.
    expect(goliveDoc).to.match(/3\.\s+\*\*Wire self-serve fulfillment/);
    // The pointer links into the EVIDENCE.md section.
    expect(goliveDoc).to.match(/EVIDENCE\.md/);
  });

  it("the boundary is stated as an ACCESS-credential-not-a-token (revenue integrity), not a security", function () {
    // Belt-and-braces: the token/coin/NFT prohibition must be present in the boundary.
    expect(evidenceDoc).to.match(/NOT a token\/coin\/NFT/);
  });
});

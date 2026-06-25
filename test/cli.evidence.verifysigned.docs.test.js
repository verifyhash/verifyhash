"use strict";

// ---------------------------------------------------------------------------
// T-47.3 docs-rot guard for `vh evidence verify-signed` (docs/EVIDENCE.md).
//
// PURE (no chain, no fixtures, no filesystem writes): asserts the recipient/buyer-facing prose documents
// `vh evidence verify-signed` the way `cli/evidence.js` actually behaves, and that NO text implies the
// content-only `vh evidence verify` checks the SIGNER. The doc must not silently drift from the code.
// Load-bearing properties the doc MUST carry (the T-47.3 acceptance criteria):
//   * names `vh evidence verify-signed` and lists it in the Commands block with the real flag surface;
//   * frames it as the recipient's "prove WHO signed this" step — the trust check the PAID signed surface
//     exists to enable;
//   * documents recover-NOT-trust (recovers the public signer from the bytes + signature, never the claimed
//     label), the `--signer` PIN, the `--dir` BINDING, and the verify-vs-verify-signed BOUNDARY;
//   * no longer implies `verify` checks the signer (the old "reports signed:true" example is gone; the doc
//     explicitly says `verify` checks CONTENT not the signer and points at `verify-signed`);
//   * restates the signer-vouch-NOT-timestamp / P-3 caveat VERBATIM (the code's VERIFY_SIGNED_SEAL_TRUST_NOTE
//     first clause);
//   * introduces NO new needs-human ITEM and does NOT re-sharpen P-3/P-5/P-6/P-7/P-8.
//
// Importing evidence.js pins the in-band caveat wording this guard reuses AND fails loudly if the module (or
// its verify-signed surface) is ever removed — the guard would otherwise be hollow.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

const evidence = require("../cli/evidence");

describe("T-47.3 docs: `vh evidence verify-signed` documented (docs/EVIDENCE.md)", function () {
  let doc, docFlat, section, sectionFlat;
  // Whitespace-collapsed views so a phrase that WRAPS across markdown lines (incl. `>` blockquote markers)
  // still matches a single-space regex — the prose meaning, not its line-wrapping, is what we pin.
  const flatten = (s) => s.replace(/\s*\n\s*>?\s*/g, " ").replace(/\s+/g, " ");

  before(function () {
    doc = read("docs/EVIDENCE.md");
    docFlat = flatten(doc);
    // The dedicated section that explains the recipient's prove-WHO-signed step.
    const start = doc.indexOf("## Proving WHO signed:");
    expect(start, "the `vh evidence verify-signed` section is present").to.be.greaterThan(-1);
    const rest = doc.slice(start);
    const end = rest.indexOf("\n## ", 3);
    section = end === -1 ? rest : rest.slice(0, end);
    sectionFlat = flatten(section);
  });

  it("evidence.js still exports the verify-signed surface + caveat this guard pins against", function () {
    // If these go away, the doc is documenting vapor — fail loudly rather than pass a hollow guard.
    expect(evidence.runEvidenceVerifySigned, "runEvidenceVerifySigned export").to.be.a("function");
    expect(evidence.verifySignedSealAttestation, "verifySignedSealAttestation export").to.be.a("function");
    expect(evidence.cmdEvidence, "cmdEvidence export").to.be.a("function");
    expect(evidence.VERIFY_SIGNED_SEAL_TRUST_NOTE, "VERIFY_SIGNED_SEAL_TRUST_NOTE export").to.be.a("string");
  });

  it("names `vh evidence verify-signed` and lists it in the Commands block with the real flag surface", function () {
    expect(doc).to.include("vh evidence verify-signed");
    const cmdStart = doc.indexOf("## Commands");
    expect(cmdStart, "Commands section present").to.be.greaterThan(-1);
    const block = doc.slice(cmdStart).split("```")[1];
    expect(block, "Commands fenced block").to.be.a("string");
    // The exact usage line: <signed>, optional --dir / --signer / --json.
    expect(block).to.match(
      /vh evidence verify-signed <signed> \[--dir <d>\] \[--signer <0xaddr>\] \[--json\]/
    );
  });

  it("frames verify-signed as the recipient's PROVE-WHO-SIGNED step the PAID signed surface exists to enable", function () {
    const f = docFlat.toLowerCase();
    // The recipient's "prove WHO signed this" framing.
    expect(f).to.match(/prove who signed this/);
    expect(f).to.match(/recipient/);
    // It is the trust check the PAID signed surface exists to enable.
    expect(f).to.match(/paid signed surface exists to enable|paid `?--sign`? surface exists to enable/);
  });

  it("documents recover-NOT-trust, the --signer PIN, the --dir binding, and Check 1 always runs", function () {
    const f = docFlat.toLowerCase();
    // recover-not-trust: it RECOVERS the public address from the bytes + signature, never the claimed label.
    expect(f).to.match(/recover-not-trust|recover not trust/);
    expect(f).to.match(/recovers? the (public )?signer( (public )?address)? from the (embedded )?(canonical )?(seal )?bytes \+ signature|recovers the public signer address from/);
    expect(docFlat).to.match(/never (the )?(believes )?(the )?claimed `?signer`? label|never trusts the container's claimed `?signer`?/i);
    // --signer pins the recovered signer to an expected publisher.
    expect(docFlat).to.match(/`?--signer`?/);
    expect(f).to.match(/pins?/);
    // --dir binds the signature to the recipient's own bytes.
    expect(docFlat).to.match(/`?--dir`?/);
    expect(f).to.match(/binds?/);
    // Check 1 (recover) always runs / is offline+key-free.
    expect(f).to.match(/offline.*key-free|key-free.*offline/);
  });

  it("documents the verify vs verify-signed BOUNDARY (content vs signer) in one place", function () {
    const f = docFlat.toLowerCase();
    // The explicit one-line boundary: verify = CONTENT, verify-signed = the SIGNER.
    expect(f).to.match(/`?verify`? = does the content match|`?verify`? checks the content/);
    expect(f).to.match(/`?verify-signed`? = does a trusted signer vouch|`?verify-signed`?.*signer/);
    // The boundary section spells out when to use which.
    expect(f).to.match(/use `?verify`? when|use `?verify-signed`? when/);
  });

  it("no longer implies `verify` checks the signer (the stale `signed:true` example is gone)", function () {
    // The OLD worked-example claimed `vh evidence verify … reports signed:true`, which implied `verify`
    // affirmed the signer. That exact stale claim must be gone.
    expect(doc, "the stale `reports signed:true` verify example is removed").to.not.match(
      /vh evidence verify [^\n]*reports signed:true/
    );
    // And the doc states plainly that `verify` checks CONTENT, not the signer.
    expect(docFlat).to.match(/`?verify`? checks the \*\*CONTENT, not the signer\*\*|`?verify`? checks the CONTENT, not the signer/i);
    // The `verify` COMMAND bullet (the one that starts "- `verify` is ...") must DISAVOW pinning the signer
    // and POINT at verify-signed, never affirm that `verify` pins/trusts the signer. Scope the check to that
    // one bullet so a (correct) "PINS" in the verify-SIGNED bullet can't trip a whole-doc scan.
    const verifyBulletStart = doc.indexOf("- `verify` is **read-only");
    expect(verifyBulletStart, "the `verify` command bullet is present").to.be.greaterThan(-1);
    const afterVerify = doc.slice(verifyBulletStart);
    const verifyBullet = afterVerify.slice(0, afterVerify.indexOf("\n- `verify-signed`"));
    expect(verifyBullet, "the `verify` bullet stops before the verify-signed bullet").to.be.a("string").and.not.equal("");
    const vb = flatten(verifyBullet);
    expect(vb, "the verify bullet disavows pinning the signer").to.match(
      /does \*\*NOT\*\* pin the signer|never reports the claimed signer as trusted|it does \*\*NOT\*\* pin/i
    );
    expect(vb, "the verify bullet points at verify-signed for WHO").to.match(/verify-signed/);
    // It must NOT affirm that `verify` pins/checks/proves the signer.
    expect(vb).to.not.match(/`?verify`? (pins|checks|proves|trusts) the signer/i);
  });

  it("restates the signer-vouch / NOT-a-timestamp / P-3 caveat VERBATIM from the code", function () {
    // The FIRST clause of the code's VERIFY_SIGNED_SEAL_TRUST_NOTE — pin it byte-for-byte so the doc caveat
    // cannot drift from the caveat the command actually prints.
    const codeCaveat =
      "A valid signature proves the HOLDER OF `signer`'s key vouched for THIS evidence seal (the embedded " +
      "root + the full set of (relPath, content) pairs). It does NOT by itself prove a trustworthy " +
      'TIMESTAMP: "sealed/vouched since a date T" still needs the human-owned signing/timestamp trust-root ' +
      "(needs-human, P-3). It is NOT a legal opinion.";
    // The note is exported by the module so this is a real cross-check, not a hand-copied literal.
    expect(evidence.VERIFY_SIGNED_SEAL_TRUST_NOTE).to.contain(codeCaveat);
    // The doc carries the SAME wording verbatim (flattened so a `>` blockquote line-wrap still matches).
    expect(docFlat).to.contain(flatten(codeCaveat));
    // It rides the EXISTING P-3 proposal (not a fresh ask).
    expect(doc).to.include("P-3");
  });

  it("introduces NO new needs-human ITEM — every needs-human mention rides an EXISTING proposal (P-3/P-7)", function () {
    // The acceptance bar is "NO new needs-human ITEM". `verify-signed` is FREE/key-free (nothing to gate), so
    // it escalates nothing. The doc may RESTATE the standing P-3 trust-root boundary (which legitimately
    // carries needs-human) verbatim — a restatement of an EXISTING proposal, not a new ask. Assert every
    // needs-human mention sits next to an already-existing proposal number (P-3 or the evidence vertical P-7).
    const allowed = new Set(["P-3", "P-7"]);
    const lines = doc.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/needs-human/i.test(lines[i])) continue;
      const context = [lines[i - 1] || "", lines[i], lines[i + 1] || ""].join(" ");
      const pNums = context.match(/P-\d+/g) || [];
      expect(pNums.length, `a needs-human mention near line ${i + 1} names its proposal`).to.be.greaterThan(0);
      for (const p of pNums) {
        expect(allowed.has(p), `needs-human near line ${i + 1} rides an EXISTING proposal (got ${p})`).to.equal(
          true
        );
      }
    }
    // The verify-signed section escalates nothing new: it carries ONLY the standing P-3 boundary as its
    // needs-human pointer (no fresh proposal, no P-5/P-6/P-8 re-sharpening text in the section).
    expect(section).to.not.match(/P-5|P-6|P-8/);
  });
});

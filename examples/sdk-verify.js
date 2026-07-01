#!/usr/bin/env node
"use strict";

// examples/sdk-verify.js — a runnable CONSUMER example that exercises the verifyhash SDK exactly as an
// EXTERNAL developer would embed it (T-57.3).
//
// THE POINT
//   An external program that installs `verifyhash` from npm and writes `require("verifyhash")` must get a
//   working seal + verify path — UNSIGNED tamper-evidence AND the SIGNED, vendor-address-PINNED verify gate
//   — with NOTHING ELSE: no deep `cli/core/...` reach-in, no network, no provider, no non-core dependency.
//   This file proves the PUBLIC surface stands on its own by using ONLY:
//     * `require("verifyhash")`          — the single documented entrypoint (index.js, via package "exports")
//     * `require("ethers")`              — a DIRECT dependency of verifyhash, re-exported by the SDK, so a
//                                          consumer who has verifyhash installed already has it; the example
//                                          uses it ONLY to mint an EPHEMERAL throwaway signing key to STAND
//                                          IN for the real, out-of-band publisher key a paying integrator
//                                          pins by ADDRESS (the loop NEVER holds a real key).
//   and nothing else. A grep in test/sdk.example.test.js asserts there is NO `require(".../cli/core/...")`
//   (or any deep cli/* path) anywhere in this file — if someone reached past the public API to make the
//   example work, that grep fails and the "public surface stands alone" claim is falsified.
//
// WHY THIS IS THE MONETIZABLE INTEGRATION (not just a hello-world)
//   The FREE tier is unsigned tamper-evidence (Act 1). The PAID, revenue-relevant use — "verified by
//   verifyhash, SIGNED and vendor-PINNED, inside YOUR product" — is Act 2: a downstream service embeds the
//   verifier and gates on "was this packet signed by OUR published vendor ADDRESS?" WITHOUT ever shelling
//   out to the `vh` binary. That is the exact integration an embedder pays for (STRATEGY.md P-9 / EPIC-58),
//   and it is what makes the free in-process verifier PULL the paid, signed seal. This example ships that
//   whole gate as ~40 lines a developer can copy.
//
// WHAT IT DEMONSTRATES
//   ACT 1 — UNSIGNED tamper-evidence (the free tier)      : ACCEPT -> REJECT -> diff
//     1. buildSeal      — seal an in-memory { relPath, bytes } file set (no directory, no disk needed).
//     2. verifySeal     — the SAME bytes re-derive the sealed root  => ACCEPTED  (authoritative by
//                         RE-COMPUTING the root from the bytes YOU hold, never from the seal's own hashes).
//     3. verifySeal     — flip ONE byte of ONE file               => REJECTED  (tamper-evidence), and print
//                         the per-file DIFF the verdict is built from (which relPath changed, expected vs got).
//     4. serializeSeal / readSeal — the canonical, byte-deterministic packet a counterparty re-reads.
//   ACT 2 — SIGNED + vendor-PINNED verify gate (the paid embed)  : ACCEPT -> REJECT(wrong vendor) -> REJECT(tamper)
//     5. signSealWith         — a PUBLISHER signs the seal (ephemeral key here; a real out-of-band key in prod).
//     6. verifySignedSeal     — PIN to the published vendor address           => ACCEPTED.
//     7. verifySignedSeal     — a GENUINE signature from the WRONG vendor      => REJECTED (the PIN fails —
//                               this is NOT tamper-evidence; the bytes are fine, the signer is not ours).
//     8. verifySignedSeal     — a one-byte-tampered signature                  => REJECTED (recovered != claimed).
//
// TRUST BOUNDARY (the example will not let you overclaim)
//   A seal proves TAMPER-EVIDENCE + OFFLINE RE-COMPUTE ("these exact bytes are what was sealed"). A valid
//   SIGNATURE additionally proves WHO vouched (the holder of the pinned address's key) for THOSE bytes. It
//   does NOT prove a trusted TIMESTAMP ("signed/unaltered since date T") — that rides the HUMAN-owned
//   signing / timestamp / anchor trust-root (needs-human; STRATEGY.md P-3) — and is NOT a legal opinion.
//   See docs/TRUST-BOUNDARIES.md. This example NEVER timestamps, anchors, or touches the network, and the
//   only key it uses is an EPHEMERAL, in-memory throwaway (never persisted, funded, or logged).
//
// RUN IT
//   node examples/sdk-verify.js         # prints the two ACCEPT/REJECT sequences, exits 0
//
// It is test-gated by test/sdk.example.test.js on every `npx hardhat test`, so it can never silently rot.

// The public package entrypoint — resolved BY NAME through package.json "exports" (Node's self-reference
// makes this identical to what an npm installer sees). This is the ONE import a consumer of the SDK needs.
const vh = require("verifyhash");
// ethers is a DIRECT dependency of verifyhash (see its package.json), so a consumer already has it. We use
// it ONLY to mint an EPHEMERAL throwaway signer that STANDS IN for the real, out-of-band publisher key a
// paying integrator would provision themselves and pin by ADDRESS. The loop NEVER holds a real key.
const { Wallet } = require("ethers");

// A tiny, in-memory { relPath, bytes } file set — the shape buildSeal/verifySeal accept. No disk, no
// directory: a consumer can seal bytes it already holds in memory (an upload, a build artifact, a payload).
const entries = [
  { relPath: "data/a.txt", bytes: Buffer.from("alpha\n") },
  { relPath: "data/b.txt", bytes: Buffer.from("bravo\n") },
  { relPath: "report.html", bytes: Buffer.from("<html>ok</html>") },
];

// A collector so the same lines print to the console AND are returned to a test harness (no stdout scraping
// required). `out` lets the test inject a sink; by default we print. The whole example is async because the
// SIGNED act awaits `signSealWith` (ethers signing is async); the unsigned act is fully synchronous.
async function runExample(out = console.log) {
  const log = (line = "") => out(line);

  log("verifyhash SDK consumer example — UNSIGNED tamper-evidence, then a SIGNED + vendor-PINNED verify gate.");
  log(`using verifyhash public API v${vh.apiVersion} (require("verifyhash") only — no deep cli/* imports).`);
  log("");
  // Lead with the standing trust boundary so the example never overclaims (mirrors the CLI's TRUST_NOTE).
  log("TRUST NOTE: a seal proves TAMPER-EVIDENCE (these exact bytes were sealed); a valid SIGNATURE proves");
  log("WHO vouched (the pinned address's key-holder) for those bytes. Neither proves a trusted timestamp");
  log("and NEITHER is a legal opinion. Timestamping rides the human-owned trust-root (needs-human).");
  log("");

  // =====================================================================================================
  // ACT 1 — UNSIGNED tamper-evidence (the FREE tier): build -> ACCEPT -> tamper REJECT -> localized diff.
  // =====================================================================================================
  log("== ACT 1: UNSIGNED tamper-evidence (free tier) ==");

  // --- (1) BUILD ----------------------------------------------------------------------------------------
  const seal = vh.buildSeal(entries);
  log(`[1] buildSeal: sealed ${seal.fileCount} files; Merkle root = ${seal.root}`);

  // --- (2) VERIFY the untouched bytes -> ACCEPTED -------------------------------------------------------
  const okResult = vh.verifySeal(seal, entries);
  log(`[2] verifySeal (untouched bytes): ${okResult.verdict}  (rootMatches=${okResult.rootMatches})`);
  if (okResult.verdict !== "ACCEPTED") {
    // Defensive: an ACCEPT here is the whole point of the happy path.
    throw new Error(`expected ACCEPTED for untouched bytes, got ${okResult.verdict}`);
  }

  // --- (3) TAMPER exactly one byte of one file -> REJECTED, and show the per-file diff ------------------
  // Flip 'o' -> 'X' in "bravo" of data/b.txt. Every other file is byte-identical.
  const tampered = entries.map((e) =>
    e.relPath === "data/b.txt" ? { relPath: e.relPath, bytes: Buffer.from("bravX\n") } : e
  );
  const badResult = vh.verifySeal(seal, tampered);
  log(`[3] verifySeal (one byte flipped in data/b.txt): ${badResult.verdict}  (rootMatches=${badResult.rootMatches})`);
  if (badResult.verdict !== "REJECTED") {
    throw new Error(`expected REJECTED for tampered bytes, got ${badResult.verdict}`);
  }

  // The DIFF the REJECT verdict is built from — localized to the changed file (expected vs. actual hash).
  log(
    `    diff: ${badResult.counts.changed} changed, ${badResult.counts.missing} missing, ` +
      `${badResult.counts.unexpected} unexpected, ${badResult.counts.matched} matched`
  );
  for (const c of badResult.changed) {
    log(`      CHANGED ${c.relPath}`);
    log(`        expected ${c.expectedContentHash}`);
    log(`        actual   ${c.actualContentHash}`);
  }

  // --- (4) SERIALIZE / READ BACK — the canonical, byte-deterministic packet ----------------------------
  const json = vh.serializeSeal(seal);
  const readBack = vh.readSeal(json);
  const rootRoundTrips = readBack.root === seal.root;
  log(`[4] serializeSeal -> readSeal round-trips: ${rootRoundTrips ? "yes" : "NO"}  (root preserved)`);
  if (!rootRoundTrips) {
    throw new Error("serializeSeal -> readSeal did not preserve the root");
  }
  // The re-read packet still ACCEPTS the original bytes — proving the portable packet is verifiable.
  const readBackAccepts = vh.verifySeal(readBack, entries).verdict === "ACCEPTED";
  if (!readBackAccepts) {
    throw new Error("re-read seal did not ACCEPT the original bytes");
  }

  // =====================================================================================================
  // ACT 2 — SIGNED + vendor-PINNED verify gate (the PAID embed). This is the integration a downstream
  // service pays for: verify IN-PROCESS that a packet was signed by OUR published vendor ADDRESS, with no
  // shell-out to the `vh` binary. The publisher's key is EPHEMERAL here; in production a publisher signs
  // with a real key they provision OUT OF BAND, and every consumer pins the published ADDRESS.
  // =====================================================================================================
  log("");
  log("== ACT 2: SIGNED + vendor-PINNED verify gate (the paid embed) ==");

  // The PUBLISHER's key — EPHEMERAL, in-memory, TEST-ONLY (Wallet.createRandom()); never persisted/funded.
  // In production this is the vendor's real, out-of-band key; a consumer only ever needs its ADDRESS.
  const publisher = Wallet.createRandom();
  const vendorAddress = publisher.address; // the ADDRESS a consumer PINS (published in docs / tool config).

  // --- (5) The publisher SIGNS the seal, WRAPPING the exact canonical seal bytes (never editing them). --
  const signedContainer = await vh.signSealWith(seal, publisher);
  log(`[5] signSealWith: publisher signed the seal; vendor address to PIN = ${vendorAddress}`);

  // --- (6) The consumer's gate: PIN to the published vendor address -> ACCEPTED ------------------------
  // verifySignedSeal recovers the signer from the signature OFFLINE (key-free) and checks it equals the
  // PINNED expectedSigner. ACCEPTED only when the signature is genuine AND recovers to our vendor.
  const pinnedOk = vh.verifySignedSeal({ container: signedContainer, expectedSigner: vendorAddress });
  log(`[6] verifySignedSeal (pinned to OUR vendor address): ${pinnedOk.verdict}  ` +
      `(recovered=${pinnedOk.recoveredSigner.slice(0, 10)}…, pinMatched=${pinnedOk.checks.signerMatchesExpected})`);
  if (pinnedOk.verdict !== "ACCEPTED") {
    throw new Error(`expected ACCEPTED for a seal signed by our pinned vendor, got ${pinnedOk.verdict}`);
  }

  // --- (7) A GENUINE signature from the WRONG vendor -> REJECTED (the PIN fails, NOT tamper-evidence) ---
  // The bytes are untouched and the signature is perfectly valid — it just recovers to a DIFFERENT address
  // than the one we pin. A paying integrator's gate MUST reject "signed by someone, but not by US."
  const wrongVendor = Wallet.createRandom().address; // a different published vendor we do NOT accept.
  const wrongPin = vh.verifySignedSeal({ container: signedContainer, expectedSigner: wrongVendor });
  log(`[7] verifySignedSeal (pinned to a DIFFERENT vendor address): ${wrongPin.verdict}  ` +
      `(signatureGenuine=${wrongPin.checks.signatureMatchesSigner}, pinMatched=${wrongPin.checks.signerMatchesExpected})`);
  if (wrongPin.verdict !== "REJECTED") {
    throw new Error(`expected REJECTED when pinned to the wrong vendor, got ${wrongPin.verdict}`);
  }
  if (wrongPin.checks.signatureMatchesSigner !== true) {
    // The point of this case: the signature IS genuine; only the PIN failed. If the signature itself looked
    // invalid here, the example would be teaching the wrong lesson.
    throw new Error("wrong-vendor case should keep a GENUINE signature; only the pin should fail");
  }

  // --- (8) A one-byte-tampered signature -> REJECTED (recovered signer != claimed) ---------------------
  // Flip ONE hex char of the detached signature (keep it 65 bytes + lowercase so the container is still
  // STRUCTURALLY valid — the rejection is a VERDICT, not a parse error). The recovered address no longer
  // matches the claimed signer, so it REJECTS even under the ORIGINAL correct vendor pin.
  const tamperedContainer = JSON.parse(JSON.stringify(signedContainer));
  const sigHex = tamperedContainer.signature.signature;
  const flipAt = 50;
  const flipTo = sigHex[flipAt] === "a" ? "b" : "a";
  tamperedContainer.signature.signature = sigHex.slice(0, flipAt) + flipTo + sigHex.slice(flipAt + 1);
  const tamperedSig = vh.verifySignedSeal({ container: tamperedContainer, expectedSigner: vendorAddress });
  log(`[8] verifySignedSeal (one hex char of the signature flipped): ${tamperedSig.verdict}  ` +
      `(signatureGenuine=${tamperedSig.checks.signatureMatchesSigner})`);
  if (tamperedSig.verdict !== "REJECTED") {
    throw new Error(`expected REJECTED for a tampered signature, got ${tamperedSig.verdict}`);
  }

  log("");
  log(
    "RESULT: PASS — Act 1 ACCEPT (untouched) then REJECT (one-byte tamper) with a localized diff; " +
      "Act 2 ACCEPT (our pinned vendor) then REJECT (wrong vendor) then REJECT (tampered signature)."
  );

  // Return a structured result so a test can assert without scraping stdout.
  return {
    apiVersion: vh.apiVersion,
    root: seal.root,
    fileCount: seal.fileCount,
    // Act 1 (unsigned).
    acceptVerdict: okResult.verdict,
    rejectVerdict: badResult.verdict,
    changed: badResult.changed.map((c) => c.relPath),
    counts: badResult.counts,
    rootRoundTrips,
    readBackAccepts,
    // Act 2 (signed + vendor-pinned).
    vendorAddress,
    signedAcceptVerdict: pinnedOk.verdict,
    wrongVendorVerdict: wrongPin.verdict,
    wrongVendorSignatureGenuine: wrongPin.checks.signatureMatchesSigner,
    wrongVendorPinMatched: wrongPin.checks.signerMatchesExpected,
    tamperedSignatureVerdict: tamperedSig.verdict,
  };
}

// Run when invoked directly (`node examples/sdk-verify.js`); export `runExample` for the test harness.
if (require.main === module) {
  runExample()
    .then(() => process.exit(0))
    .catch((err) => {
      // Any failure is a non-zero exit so CI (and the test's child-process check) catches it.
      console.error(`sdk-verify example FAILED: ${err && err.message ? err.message : err}`);
      process.exit(1);
    });
}

module.exports = { runExample, entries };

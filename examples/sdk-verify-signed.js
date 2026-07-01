#!/usr/bin/env node
"use strict";

// examples/sdk-verify-signed.js — a runnable SIGNED-VERIFY example: a buyer who RECEIVED a signed,
// vendor-pinned deliverable ON DISK answers the two questions that gate a real purchase — "was this signed
// by the vendor address I PIN?" AND "are the exact bytes I received the ones that vendor signed?" — using
// ONLY the public verifyhash SDK, in-process, with NO shell-out (T-58.2).
//
// THE POINT (the paid, revenue-relevant embed)
//   A downstream service RECEIVES a signed, vendor-address-pinned deliverable (a model, a dataset, a build
//   artifact) and must clear TWO gates before it trusts the bytes it will ship/train on:
//     (a) "is this signed by OUR published vendor address?"  — reject "signed, but not by us", and
//     (b) "are the exact files I RECEIVED ON DISK the ones the vendor signed?" — reject a swapped/altered
//          download even when the signature is a GENUINE vendor signature over the ORIGINAL bytes.
//   Gate (b) — the on-disk BINDING check — is the one a paying integrator actually cares about: it is what
//   catches a tampered/substituted deliverable, the real fraud. This example runs BOTH gates the way a
//   paying integrator embeds them — through the single public entrypoint `require("verifyhash")` — with NO
//   deep `cli/...` reach-in, NO `child_process` shell-out to the `vh` binary, and NO network. It is the
//   SIGNED twin of `vh evidence verify-signed` (incl. its `--signer` pin and `--dir` binding), byte-
//   identical because it IS the same code (index.js is a thin identity re-export; docs/SDK.md pins it).
//
//   The VERIFY example imports ONLY `require("verifyhash")` + a relative helper. It plays the BUYER, who
//   never signs and never touches a built-in: the PUBLISHER-side key handling (minting an EPHEMERAL
//   throwaway key that stands in for the publisher's real out-of-band key) AND the "receive the deliverable
//   to disk / corrupt one received file / clean up the temp dir" plumbing are quarantined in
//   examples/lib/ephemeral-publisher.js. A grep in test/sdk.example.signed.test.js asserts THIS file imports
//   nothing but the package + relative files, no deep cli/*, no child_process, no built-in, no network.
//
// WHAT IT DEMONSTRATES — one ACCEPT, then THREE independent REJECTs, escalating in value
//   [1] verifySignedSeal PINNED to OUR published vendor address        => ACCEPTED  (the address gate)
//   [2] verifySignedSeal PINNED to a DIFFERENT (wrong) vendor address  => REJECTED  (wrong-signer: the
//        signature is GENUINE — the bytes are fine — but it recovers to a signer we do NOT pin. "Signed by
//        someone, but not by US" MUST reject; this is the exact gate a paying integrator needs, and it is
//        NOT tamper-evidence.)
//   [3] verifySignedSeal on a one-byte-TAMPERED signature              => REJECTED  (sig-tamper: the
//        recovered signer no longer matches the claimed one, so it rejects even under the CORRECT vendor pin.)
//   [4] verifySignedSealAttestation BOUND to the RECEIVED files on disk, PINNED to OUR vendor address:
//        [4a] the UNTOUCHED received deliverable                        => ACCEPTED  (both gates pass: our
//              vendor signed it AND the bytes on disk are byte-identical to what was signed)
//        [4b] the received deliverable with ONE file CORRUPTED on disk  => REJECTED  (content-tamper:
//              `manifestBindsAttestation=false`. The signature is STILL a genuine vendor signature over the
//              ORIGINAL bytes — `signatureMatchesSigner` and the vendor pin both still pass — but the
//              received directory NO LONGER matches what was signed. This is the fraud gate (a) + (b) alone
//              catch: a real, our-vendor signature attached to a SUBSTITUTED download. The signature-only
//              path [1]–[3] CANNOT catch this; the on-disk binding does.)
//
// TRUST BOUNDARY (the example will not let you overclaim)
//   A valid SIGNATURE proves WHO vouched — the holder of the pinned address's key — for THESE exact sealed
//   bytes. It does NOT prove a trusted TIMESTAMP ("signed/unaltered since date T" rides the HUMAN-owned
//   signing / timestamp / anchor trust-root, needs-human; STRATEGY.md P-3) and is NOT a legal opinion.
//   Verification is OFFLINE / key-free: it recovers a PUBLIC address from the signature, holds no private
//   key, and contacts nothing. See docs/TRUST-BOUNDARIES.md.
//
// RUN IT
//   node examples/sdk-verify-signed.js
//   # prints ACCEPT (our pinned vendor), REJECT (wrong signer), REJECT (tampered signature),
//   # ACCEPT (bound to the untouched received files on disk), REJECT (a received file corrupted on disk),
//   # then a PASS summary, and exits 0. Nothing is written to the repo tree (a throwaway OS temp dir only).
//
// Test-gated by test/sdk.example.signed.test.js on every `npx hardhat test`, so it can never silently rot.

// The public package entrypoint — the ONE import a consumer of the SDK needs. Resolved BY NAME through
// package.json "exports", identical to what an npm installer sees.
const vh = require("verifyhash");
// A RELATIVE example helper that quarantines the PUBLISHER-side key handling (see its header). The buyer's
// verify path below touches no key and no ethers — only this relative file + the public SDK.
const publisher = require("./lib/ephemeral-publisher");

// A tiny, in-memory { relPath, bytes } file set — the shape buildSeal accepts. Stands in for a real signed
// deliverable (a model, a dataset, a build artifact) a publisher signs and a buyer verifies.
const entries = [
  { relPath: "model/weights.bin", bytes: Buffer.from("WEIGHTS-v1\n") },
  { relPath: "model/config.json", bytes: Buffer.from('{"layers":12}\n') },
  { relPath: "LICENSE.txt", bytes: Buffer.from("Apache-2.0\n") },
];

// A collector so the same lines print to the console AND are returned to a test harness (no stdout scraping
// required). Async because signing (in the helper) awaits ethers; the buyer's verify steps are synchronous.
async function runExample(out = console.log) {
  const log = (line = "") => out(line);

  log("verifyhash SDK — SIGNED + vendor-PINNED verify gate (the paid embed).");
  log(`using verifyhash public API v${vh.apiVersion} (require("verifyhash") only — no deep cli/* imports).`);
  log("");
  // Lead with the standing trust boundary so the example never overclaims (mirrors the CLI's TRUST_NOTE).
  log("TRUST NOTE: a valid SIGNATURE proves WHO vouched (the pinned address's key-holder) for THESE exact");
  log("sealed bytes. It does NOT prove a trusted timestamp and is NOT a legal opinion. Timestamping rides");
  log("the human-owned trust-root (needs-human, STRATEGY.md P-3). Verify is OFFLINE and key-free.");
  log("");

  // --- PUBLISHER side (quarantined in the relative helper; a buyer never does this) --------------------
  // A publisher signs the seal with an EPHEMERAL throwaway key standing in for their real out-of-band key,
  // and publishes the resulting vendor ADDRESS out-of-band (e.g. a `vh identity` card). The buyer pins it.
  const { container: signedPacket, vendorAddress } = await publisher.buildAndSignSeal(entries);
  log(`publisher signed the seal; the vendor address to PIN (published out-of-band) = ${vendorAddress}`);
  log("");

  // =====================================================================================================
  // BUYER side — the gate. Everything below uses ONLY the public `vh.*` surface on the received packet.
  // =====================================================================================================

  // Strictly validate the received container FIRST (mirrors the CLI: read + validate BEFORE recovery). A
  // structurally-broken packet is a hard error here, distinct from a clean REJECTED verdict below.
  vh.validateSignedSeal(signedPacket);

  // --- [1] PIN to OUR published vendor address -> ACCEPTED ---------------------------------------------
  // verifySignedSeal recovers the signer from the signature OFFLINE (key-free) and checks it equals the
  // PINNED expectedSigner. ACCEPTED only when the signature is genuine AND recovers to our vendor.
  const accepted = vh.verifySignedSeal({ container: signedPacket, expectedSigner: vendorAddress });
  log(
    `[1] verifySignedSeal (pinned to OUR vendor address): ${accepted.verdict}  ` +
      `(recovered=${accepted.recoveredSigner.slice(0, 12)}…, pinMatched=${accepted.checks.signerMatchesExpected})`
  );
  if (accepted.verdict !== "ACCEPTED") {
    throw new Error(`expected ACCEPTED for a seal signed by our pinned vendor, got ${accepted.verdict}`);
  }

  // --- [2] PIN to a DIFFERENT vendor -> REJECTED (wrong-signer; the signature is still GENUINE) --------
  // The bytes + signature are untouched and perfectly valid — they just recover to a DIFFERENT address than
  // the one we pin. A paying integrator's gate MUST reject "signed by someone, but not by US". This is NOT
  // tamper-evidence: the packet is fine; the SIGNER is not ours.
  const wrongVendorAddress = publisher.newEphemeralPublisher().address; // a vendor we do NOT accept
  const wrongSigner = vh.verifySignedSeal({ container: signedPacket, expectedSigner: wrongVendorAddress });
  log(
    `[2] verifySignedSeal (pinned to a DIFFERENT vendor address): ${wrongSigner.verdict}  ` +
      `(signatureGenuine=${wrongSigner.checks.signatureMatchesSigner}, pinMatched=${wrongSigner.checks.signerMatchesExpected})`
  );
  if (wrongSigner.verdict !== "REJECTED") {
    throw new Error(`expected REJECTED when pinned to the wrong vendor, got ${wrongSigner.verdict}`);
  }
  if (wrongSigner.checks.signatureMatchesSigner !== true) {
    // The lesson of this case: the signature IS genuine; only the PIN failed. If the signature itself looked
    // invalid here, the example would be teaching the wrong thing.
    throw new Error("wrong-signer case must keep a GENUINE signature; only the pin should fail");
  }

  // --- [3] A one-byte-TAMPERED signature -> REJECTED (recovered signer != claimed) ---------------------
  // Flip ONE hex char of the detached signature (still lowercase + 65 bytes, so the container is STILL
  // structurally valid — the rejection is a VERDICT, not a parse error). The recovered address no longer
  // matches the claimed signer, so it REJECTS even under the ORIGINAL correct vendor pin.
  const tamperedPacket = publisher.tamperSignature(signedPacket);
  vh.validateSignedSeal(tamperedPacket); // structurally valid: the rejection below is a verdict
  const tampered = vh.verifySignedSeal({ container: tamperedPacket, expectedSigner: vendorAddress });
  log(
    `[3] verifySignedSeal (one hex char of the signature flipped): ${tampered.verdict}  ` +
      `(signatureGenuine=${tampered.checks.signatureMatchesSigner})`
  );
  if (tampered.verdict !== "REJECTED") {
    throw new Error(`expected REJECTED for a tampered signature, got ${tampered.verdict}`);
  }

  // --- [4] BIND the signature to the ACTUAL received files ON DISK — the strict gate a buyer really needs.
  // A buyer does not verify an in-memory abstraction; they verify the deliverable they DOWNLOADED. So we
  // materialize the received files to a throwaway temp dir (the "receive to disk" plumbing is quarantined in
  // the relative helper — never the repo tree) and run `verifySignedSealAttestation({container, expectedSigner,
  // dir})`, the SAME strict path as `vh evidence verify-signed --signer <addr> --dir <path>`. It clears BOTH
  // gates at once: our-vendor pin AND byte-identity of the on-disk directory to what was signed.
  const received = publisher.receiveToDisk(entries);
  let boundAccept, boundTamper;
  try {
    // [4a] The UNTOUCHED received deliverable -> ACCEPTED. Both gates pass: signed by our vendor AND the
    // bytes on disk are byte-identical to the signed payload (manifestBindsAttestation=true).
    boundAccept = vh.verifySignedSealAttestation({
      container: signedPacket,
      expectedSigner: vendorAddress,
      dir: received.dir,
    });
    log(
      `[4a] verifySignedSealAttestation (pinned + BOUND to the received files on disk): ${boundAccept.verdict}  ` +
        `(pinMatched=${boundAccept.checks.signerMatchesExpected}, ` +
        `bytesOnDiskBind=${boundAccept.checks.manifestBindsAttestation})`
    );
    if (boundAccept.verdict !== "ACCEPTED") {
      throw new Error(`expected ACCEPTED for the untouched received deliverable, got ${boundAccept.verdict}`);
    }
    if (boundAccept.checks.manifestBindsAttestation !== true) {
      throw new Error("the untouched received directory must BIND the signed bytes");
    }

    // [4b] CORRUPT ONE received file ON DISK, then re-run the SAME gate -> REJECTED. This is the real fraud:
    // the signature is STILL a genuine our-vendor signature over the ORIGINAL bytes (signatureGenuine=true,
    // pin still matches), but the received directory no longer matches what was signed — so binding fails
    // (manifestBindsAttestation=false). The signature-only checks [1]-[3] would ACCEPT this; only the on-disk
    // binding catches a substituted download. THIS is the gate a paying integrator buys.
    publisher.tamperFileOnDisk(received.dir, entries[0].relPath);
    boundTamper = vh.verifySignedSealAttestation({
      container: signedPacket,
      expectedSigner: vendorAddress,
      dir: received.dir,
    });
    log(
      `[4b] verifySignedSealAttestation (one received file corrupted on disk): ${boundTamper.verdict}  ` +
        `(signatureGenuine=${boundTamper.checks.signatureMatchesSigner}, ` +
        `pinMatched=${boundTamper.checks.signerMatchesExpected}, ` +
        `bytesOnDiskBind=${boundTamper.checks.manifestBindsAttestation})`
    );
    if (boundTamper.verdict !== "REJECTED") {
      throw new Error(`expected REJECTED for a corrupted received deliverable, got ${boundTamper.verdict}`);
    }
    if (boundTamper.checks.manifestBindsAttestation !== false) {
      throw new Error("a corrupted received directory MUST fail the on-disk binding check");
    }
    if (boundTamper.checks.signatureMatchesSigner !== true || boundTamper.checks.signerMatchesExpected !== true) {
      // The lesson of this case: the signature is STILL a genuine vendor signature; only the on-disk BYTES
      // drifted. If the signature/pin also failed here, the example would blur the two distinct rejections.
      throw new Error("content-tamper case must keep a GENUINE vendor signature; only the on-disk bytes should fail");
    }
  } finally {
    // Never leak a temp dir — remove the received deliverable even if a check above threw.
    received.cleanup();
  }

  // The received packet was never mutated by verification (verify only READS it).
  const unchanged = vh.recoverSigner(signedPacket) === vendorAddress.toLowerCase();
  if (!unchanged) {
    throw new Error("the received signed packet must be unchanged by verification");
  }

  log("");
  log(
    "RESULT: PASS — ACCEPT (our pinned vendor) then REJECT (wrong signer, genuine signature) then " +
      "REJECT (tampered signature) then ACCEPT (bound to the untouched received files on disk) then " +
      "REJECT (a received file corrupted on disk — genuine vendor signature, but the bytes no longer bind). " +
      "The gate accepts ONLY a packet signed by the pinned vendor whose exact bytes you actually received."
  );

  // Return a structured result so a test can assert without scraping stdout.
  return {
    apiVersion: vh.apiVersion,
    vendorAddress,
    acceptVerdict: accepted.verdict,
    wrongSignerVerdict: wrongSigner.verdict,
    wrongSignerSignatureGenuine: wrongSigner.checks.signatureMatchesSigner,
    wrongSignerPinMatched: wrongSigner.checks.signerMatchesExpected,
    tamperedVerdict: tampered.verdict,
    tamperedSignatureGenuine: tampered.checks.signatureMatchesSigner,
    // [4] the on-disk binding gate — the paying-customer path.
    boundAcceptVerdict: boundAccept.verdict,
    boundAcceptBinds: boundAccept.checks.manifestBindsAttestation,
    boundTamperVerdict: boundTamper.verdict,
    boundTamperBinds: boundTamper.checks.manifestBindsAttestation,
    boundTamperSignatureGenuine: boundTamper.checks.signatureMatchesSigner,
    boundTamperPinMatched: boundTamper.checks.signerMatchesExpected,
    packetUnchanged: unchanged,
  };
}

// Run when invoked directly (`node examples/sdk-verify-signed.js`); export `runExample` for the test harness.
if (require.main === module) {
  runExample()
    .then(() => process.exit(0))
    .catch((err) => {
      // Any failure is a non-zero exit so CI (and the test's child-process check) catches it.
      console.error(`sdk-verify-signed example FAILED: ${err && err.message ? err.message : err}`);
      process.exit(1);
    });
}

module.exports = { runExample, entries };

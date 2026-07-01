#!/usr/bin/env node
"use strict";

// examples/lib/ephemeral-publisher.js — a tiny, relative helper for the signed-verify example.
//
// WHY THIS FILE EXISTS (and why the signing lives HERE, not in the verify example)
//   examples/sdk-verify-signed.js is a VERIFY example: it plays the part of a BUYER who RECEIVES a signed,
//   vendor-address-pinned packet and gates on "was this signed by the vendor address I pin?" — using ONLY
//   the public `require("verifyhash")` surface. A buyer NEVER signs; signing is the PUBLISHER's job, done
//   OUT OF BAND with a key the publisher provisioned themselves (the loop NEVER holds a real key).
//
//   To keep that example a faithful "verify only" story — importing ONLY `require("verifyhash")` and
//   relative example files (a grep in test/sdk.example.signed.test.js asserts exactly that) — the
//   PUBLISHER-side key handling is quarantined HERE, in a relative helper the example pulls in. This helper
//   is the ONLY place `ethers` (verifyhash's OWN declared dependency) is touched, and it uses it for ONE
//   thing: minting an EPHEMERAL, in-memory throwaway signing key to STAND IN for the publisher's real,
//   out-of-band key. That key is never persisted, funded, or logged.
//
//   Signing itself goes through the PUBLIC SDK (`vh.signSealWith`) — this helper adds NO crypto and NO new
//   mechanism; it only supplies a throwaway signer object. So the packet the buyer verifies is produced by
//   exactly the public, CLI-identical signed path.
//
// PURE / OFFLINE — no chain, no provider, no network, no real key. `Wallet.createRandom()` is an ephemeral,
// in-memory, TEST-ONLY key. The loop NEVER holds a real key.

const vh = require("verifyhash");
// ethers is a DIRECT dependency of verifyhash (see its package.json). We use it ONLY to mint an EPHEMERAL
// throwaway signer that STANDS IN for the publisher's real, out-of-band key. Quarantined to this helper so
// the verify example proper imports nothing but `verifyhash` + relative files.
const { Wallet } = require("ethers");
// Node built-ins for the "buyer RECEIVES the deliverable to disk" plumbing (write the received files to a
// throwaway temp dir, tamper one on disk, clean up). ALSO quarantined here so the verify example stays a
// faithful "public SDK + relative files only" story — the grep in test/sdk.example.signed.test.js asserts
// the example itself imports NO built-ins. The example calls the PUBLIC `vh.verifySignedSealAttestation`
// on the directory this helper produced; this helper adds no crypto and no verify logic.
const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Mint an EPHEMERAL, in-memory throwaway signer (TEST-ONLY). Stands in for a real, out-of-band publisher
 * key a paying integrator provisions themselves. Never persisted, funded, or logged.
 * @returns {{ address: string, wallet: object }} the throwaway signer + its PUBLIC address
 */
function newEphemeralPublisher() {
  const wallet = Wallet.createRandom();
  return { address: wallet.address, wallet };
}

/**
 * Build + sign a seal over an in-memory `{ relPath, bytes }` entry list, using the PUBLIC SDK
 * (`vh.buildSeal` + `vh.signSealWith`). The signer is a caller-supplied throwaway wallet (or a fresh one).
 * Returns the signed container plus the public vendor address to PIN — exactly the two artifacts a real
 * publisher would hand a buyer (the address is published out-of-band; the container travels with the data).
 *
 * @param {Array<{relPath: string, bytes: Buffer}>} entries the in-memory file set to seal
 * @param {object} [wallet] an ethers signer-like object (defaults to a fresh ephemeral throwaway)
 * @returns {Promise<{ container: object, vendorAddress: string, seal: object }>}
 */
async function buildAndSignSeal(entries, wallet) {
  const signer = wallet || Wallet.createRandom();
  const seal = vh.buildSeal(entries);
  const container = await vh.signSealWith(seal, signer);
  return { container, vendorAddress: signer.address, seal };
}

/**
 * Produce a one-byte-TAMPERED copy of a signed container: flip exactly ONE hex char of the detached
 * signature, keeping it lowercase + 65 bytes so the container stays STRUCTURALLY valid — the rejection is
 * a VERDICT (recovered signer != claimed), not a parse error. Returns a fresh object; the input is not
 * mutated.
 * @param {object} container a signed-seal container
 * @returns {object} a structurally-valid but signature-tampered copy
 */
function tamperSignature(container) {
  const copy = JSON.parse(JSON.stringify(container));
  const sig = copy.signature.signature;
  const idx = 50; // an arbitrary interior position of the 130-hex-char signature
  const flipTo = sig[idx] === "a" ? "b" : "a";
  copy.signature.signature = sig.slice(0, idx) + flipTo + sig.slice(idx + 1);
  return copy;
}

/**
 * Materialize a received deliverable to a FRESH throwaway temp dir — the plumbing of "a buyer downloaded
 * the vendor's files and dropped them on disk". Writes each `{ relPath, bytes }` entry under a unique
 * `os.tmpdir()` directory (POSIX relPaths split into nested dirs), NEVER into the repo working tree, so the
 * example can run `vh.verifySignedSealAttestation({ container, expectedSigner, dir })` — the STRICT gate
 * that binds the signature to the exact bytes ON DISK. Returns the absolute dir and a `cleanup()` that
 * removes it (the caller runs cleanup in a `finally`, so a temp dir never leaks even on failure).
 *
 * @param {Array<{relPath: string, bytes: Buffer}>} entries the received file set to drop on disk
 * @returns {{ dir: string, cleanup: () => void }}
 */
function receiveToDisk(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-sdk-signed-example-"));
  for (const { relPath, bytes } of entries) {
    const abs = path.join(dir, relPath.split("/").join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
  }
  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort: a temp dir the OS reaps anyway */
    }
  };
  return { dir, cleanup };
}

/**
 * Corrupt ONE received file ON DISK — flip a byte of `relPath` under `dir`. Stands in for "the deliverable
 * a buyer downloaded was swapped/altered in transit or at rest". The signature over the vendor's ORIGINAL
 * bytes stays perfectly genuine; it simply no longer BINDS the tampered directory — which is exactly why
 * `vh.verifySignedSealAttestation({ ..., dir })` REJECTS with `manifestBindsAttestation=false`.
 * @param {string} dir the received deliverable directory
 * @param {string} relPath the POSIX relPath of the file to corrupt
 */
function tamperFileOnDisk(dir, relPath) {
  const abs = path.join(dir, relPath.split("/").join(path.sep));
  const original = fs.readFileSync(abs);
  // Append one byte — the smallest possible content change; the Merkle root over the directory shifts.
  fs.writeFileSync(abs, Buffer.concat([original, Buffer.from("X")]));
}

module.exports = {
  newEphemeralPublisher,
  buildAndSignSeal,
  tamperSignature,
  receiveToDisk,
  tamperFileOnDisk,
};

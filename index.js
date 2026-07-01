"use strict";

// index.js — the SINGLE, documented, semver-guarded PUBLIC API entrypoint for verifyhash (T-57.1).
//
// WHAT THIS IS
//   A THIN re-export of the already-built, already-tested core so a downstream program can `require`
//   verifyhash as a library and get the EXACT SAME functions the `vh` CLI runs — no fork, no second
//   implementation, no new crypto or mechanism introduced here. Every symbol below is the SAME function
//   object exported by its `cli/…` source module (an identity re-export, asserted by the tests). If the
//   CLI's behavior changes, this API changes with it automatically, because it IS the CLI's code.
//
//   The embedded ("SDK") path and the CLI path are therefore the same code path: a seal built via
//   `sdk.buildSeal(...)` verifies (ACCEPT) with `sdk.verifySeal(...)`, and a one-byte tamper is REJECTED
//   — identical to `vh evidence seal` / `vh evidence verify`.
//
// TRUST BOUNDARY (unchanged from the CLI — this wrapper adds nothing)
//   A seal proves TAMPER-EVIDENCE + OFFLINE RE-COMPUTE ("these exact bytes are what was sealed"), NOT a
//   trusted timestamp and NOT who authored the bytes. Signing/timestamping still ride the human-owned
//   trust-root. `verifySeal` RE-DERIVES the Merkle root from the bytes YOU supply — never the seal's own
//   stored hashes. See docs/TRUST-BOUNDARIES.md.
//
// STABILITY / SEMVER
//   This module is the package's stability contract. `apiVersion` mirrors `package.json`'s version and
//   is the semver-guarded surface: anything re-exported here is a PUBLIC symbol whose removal or breaking
//   change requires a semver-major bump; symbols NOT re-exported here (deep `cli/…` internals) carry no
//   stability guarantee. Add to this surface deliberately.

const pkg = require("./package.json");

// ---- Source modules (the already-built core; NOT re-implemented here) -------------------------------
// The seal SDK is bound to a REAL product config (`vh evidence`) over the generic packetseal core, so
// the embedded path is byte-identical to the CLI seal path.
const evidence = require("./cli/evidence");
const receipt = require("./cli/receipt");
const packetseal = require("./cli/core/packetseal");
const hash = require("./cli/hash");

// ---------------------------------------------------------------------------
// THE PUBLIC SURFACE — each value is the SAME function object as its `cli/…` source (identity re-export).
// Grouped for humans; also spread flat at the top level for convenience.
// ---------------------------------------------------------------------------

// (1) Seal SDK — build / verify a tamper-evident evidence seal from a flat { relPath, bytes } entry list.
//     buildSeal(entries)         -> seal object
//     validateSeal(seal)         -> throws on structural / root-mismatch problems
//     serializeSeal(seal)        -> canonical, byte-deterministic JSON (newline-terminated)
//     readSeal(jsonOrObject)     -> parsed + strictly validated seal
//     verifySeal(seal, entries)  -> { verdict: "ACCEPTED" | "REJECTED", accepted, ... }  (RE-DERIVES root)
const seal = Object.freeze({
  KIND: evidence.SEAL_KIND,
  SCHEMA_VERSION: evidence.SEAL_SCHEMA_VERSION,
  TRUST_NOTE: evidence.EVIDENCE_TRUST_NOTE,
  buildSeal: evidence.buildSeal,
  validateSeal: evidence.validateSeal,
  serializeSeal: evidence.serializeSeal,
  readSeal: evidence.readSeal,
  verifySeal: evidence.verifySeal,
  // The generic, product-agnostic seal core the above are bound to (advanced / custom products).
  PacketSealError: packetseal.PacketSealError,
});

// (2) Receipts — the anchor/claim receipt codec + the path-bound manifest diff.
const receipts = Object.freeze({
  SCHEMA_VERSION: receipt.SCHEMA_VERSION,
  CLAIM_RECEIPT_KIND: receipt.CLAIM_RECEIPT_KIND,
  ANCHOR_RECEIPT_KIND: receipt.ANCHOR_RECEIPT_KIND,
  buildReceipt: receipt.buildReceipt,
  buildAnchorReceipt: receipt.buildAnchorReceipt,
  writeReceipt: receipt.writeReceipt,
  readReceipt: receipt.readReceipt,
  diffManifest: receipt.diffManifest,
});

// (3) Hashing primitives — the SAME keccak/Merkle helpers every seal + receipt is built on.
const hashing = Object.freeze({
  hashBytes: hash.hashBytes,
  hashFile: hash.hashFile,
  hashEntries: hash.hashEntries,
  hashDir: hash.hashDir,
  hashPath: hash.hashPath,
  buildTree: hash.buildTree,
});

// ---------------------------------------------------------------------------
// Flat top-level export map. Every function property is the identity re-export of its source.
// ---------------------------------------------------------------------------
module.exports = Object.freeze({
  // Semver-guarded version of THIS public surface (mirrors package.json).
  apiVersion: pkg.version,

  // Grouped namespaces.
  seal,
  receipts,
  hashing,

  // Flat convenience re-exports (identity with the grouped + source symbols).
  // --- seal SDK ---
  buildSeal: evidence.buildSeal,
  validateSeal: evidence.validateSeal,
  serializeSeal: evidence.serializeSeal,
  readSeal: evidence.readSeal,
  verifySeal: evidence.verifySeal,
  PacketSealError: packetseal.PacketSealError,
  // --- receipts ---
  buildReceipt: receipt.buildReceipt,
  buildAnchorReceipt: receipt.buildAnchorReceipt,
  writeReceipt: receipt.writeReceipt,
  readReceipt: receipt.readReceipt,
  diffManifest: receipt.diffManifest,
  // --- hashing ---
  hashBytes: hash.hashBytes,
  hashFile: hash.hashFile,
  hashEntries: hash.hashEntries,
  hashDir: hash.hashDir,
  hashPath: hash.hashPath,
  buildTree: hash.buildTree,
});

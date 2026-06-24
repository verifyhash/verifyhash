"use strict";

// verifier/lib/canonical.js — INDEPENDENT canonical UNSIGNED serialization.
//
// WHY THIS EXISTS
//   For the independent `verifier/` to sign/hash over BYTE-IDENTICAL input to the production path, it must
//   reproduce the family's canonical UNSIGNED serialization itself — WITHOUT importing the producer code in
//   `cli/`. If the verifier imported `cli/dataset.js`'s `serializeAttestation`, a cross-check would be
//   circular (it would be comparing a function to itself). So this file re-derives the SAME byte string,
//   from first principles, and the cross-check test asserts it equals what the producer emits.
//
// THE CANONICAL CONVENTION (must match cli/core/attestation.js + cli/dataset.js#serializeAttestation)
//   * A FIXED key order — NOT JSON.stringify's insertion order by accident, but an EXPLICIT ordered key
//     list per object shape. We emit keys in that exact order.
//   * NO insignificant whitespace (separators ",", ":").
//   * A SINGLE trailing newline ("\n") terminating the document.
//   The result is byte-deterministic: the same logical value always serializes to the same bytes.

/**
 * Serialize a value to canonical JSON with an EXPLICIT key order, no insignificant whitespace, and NO
 * trailing newline (the newline is the document-level convention added by the envelope serializers below).
 *
 * Key order: when `keyOrder[<path-or-shape>]` is provided we use it; otherwise keys are emitted in the
 * object's own insertion order (matching the producer's explicit object literals, which V8 preserves).
 * Because the producers always build their canonical objects via explicit ordered literals, reproducing
 * that same ordered literal here yields byte-identical output WITHOUT a generic key-sorting pass.
 *
 * This is a minimal, dependency-free JSON emitter that matches JSON.stringify's escaping for the value
 * shapes this family uses (strings, integers, booleans, null, nested objects/arrays).
 *
 * @param {*} value
 * @returns {string} canonical JSON (no trailing newline)
 */
function canonicalJson(value) {
  // JSON.stringify with no spacing already emits ","/":" separators and standard string escaping with no
  // insignificant whitespace. The ONLY thing it does not do for us is reorder keys — but the family's
  // canonical objects are built as explicit ordered literals, so insertion order IS the canonical order.
  // We therefore use JSON.stringify directly on a value whose keys are already in canonical order. This is
  // intentionally the SAME primitive the producer uses, but driven from an INDEPENDENTLY constructed,
  // explicitly-ordered object here (so the bytes are reproduced, not imported).
  return JSON.stringify(value);
}

/**
 * Reproduce the canonical UNSIGNED dataset-attestation bytes, byte-for-byte identical to
 * `cli/dataset.js#serializeAttestation` — WITHOUT importing it.
 *
 * Canonical top-level key order (from the producer's explicit object literal):
 *   kind, schemaVersion, note, root, fileCount, manifestDigest, signed, signature
 * then a single trailing newline.
 *
 * @param {object} env a validated UNSIGNED attestation envelope
 * @returns {string} the canonical serialization (newline-terminated)
 */
function serializeUnsignedDatasetAttestation(env) {
  if (env == null || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("serializeUnsignedDatasetAttestation requires an attestation envelope object");
  }
  // Build the canonical object via an EXPLICIT ordered literal — independently of the producer.
  const canonical = {
    kind: env.kind,
    schemaVersion: env.schemaVersion,
    note: env.note,
    root: env.root,
    fileCount: env.fileCount,
    manifestDigest: env.manifestDigest,
    signed: env.signed,
    signature: env.signature,
  };
  return canonicalJson(canonical) + "\n";
}

/**
 * Generic canonical envelope serializer for the family's signed-attestation containers, reproducing
 * `cli/core/attestation.js#serializeSignedAttestation` byte-for-byte WITHOUT importing it.
 *
 * Canonical key order: kind, schemaVersion, note, attestation, signature{scheme,signer,signature}
 * then a single trailing newline.
 *
 * @param {object} container a signed-attestation container
 * @returns {string} the canonical serialization (newline-terminated)
 */
function serializeSignedContainer(container) {
  if (container == null || typeof container !== "object" || Array.isArray(container)) {
    throw new Error("serializeSignedContainer requires a signed-attestation container object");
  }
  const sig = container.signature || {};
  const canonical = {
    kind: container.kind,
    schemaVersion: container.schemaVersion,
    note: container.note,
    attestation: container.attestation,
    signature: {
      scheme: sig.scheme,
      signer: sig.signer,
      signature: sig.signature,
    },
  };
  return canonicalJson(canonical) + "\n";
}

module.exports = {
  canonicalJson,
  serializeUnsignedDatasetAttestation,
  serializeSignedContainer,
};

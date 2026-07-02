"use strict";

// verifier/lib/revocation.js — the STACK-FREE recipient-side KEY-REVOCATION reader + as-of decision for the
// INDEPENDENT verifier (EPIC-51 / T-51.4).
//
// WHY THIS EXISTS
//   The producer stack already lets a recipient downgrade an otherwise-ACCEPTED signed artifact to REVOKED
//   when the signing key was revoked-before-the-as-of-instant (`vh ... verify-signed --revocations <f>
//   --as-of <T>`, cli/core/trust-asof.js + cli/core/revocation.js). The OFFLINE, no-producer-stack verifier
//   (`verify-vh`) did NOT — so a counterparty who only holds the single-file verifier reached a DIFFERENT
//   verdict than the producer on the SAME inputs (a clean ACCEPTED where the producer returned REVOKED).
//   This module closes that gap WITHOUT pulling in ethers/hardhat or back-edging into cli/: it RE-IMPLEMENTS
//   the revocation soundness check (EIP-191 signer recovery + the load-bearing SELF-CONTROL invariant) and
//   the as-of trust decision using ONLY the verifier's own pure-JS crypto (./secp256k1-recover, ./keccak).
//
// MODULE LAYOUT (T-66.1 split — surface + behavior UNCHANGED)
//   Every PURE piece of this module — the discriminators/grammars/trust notes, the structural validation, the
//   signer recovery, the as-of classification/decision, the verify-result fold, the renderer — lives in
//   ./revocation-core.js (which requires NO fs/path/os, so the verifier's IN-MEMORY bytes path can reach it
//   without ANY impure builtin on its require graph). This file re-exports ALL of it VERBATIM (the very same
//   function objects) and adds the two — and only two — fs-backed conveniences: `readRevocationsFromPath`
//   (the --revocations <file-or-dir> reader) and `loadAndApply` (the one-call CLI integration). Every
//   existing caller keeps its exact import surface; on identical inputs every function is byte-identical.
//
// THE LOAD-BEARING SAFETY INVARIANT — A REVOCATION CAN ONLY EVER REMOVE TRUST, NEVER ADD IT.
//   Every revocation statement is verified the SAME way the producer core does: it must (1) recover to its
//   own claimed `signer` AND (2) recover to its own embedded `vendorAddress` (a key revokes ITSELF). A
//   revocation that fails EITHER check — forged, tampered, third-party, structurally malformed, or simply
//   not parseable — is IGNORED with a WARNING and can NEVER downgrade the verdict. So a planted "revocation"
//   for a victim's key cannot grief a recipient into rejecting a perfectly good artifact.
//
// SUBJECT-SCOPING — A REVOCATION ONLY BITES THE KEY IT NAMES.
//   The `subject` is the artifact's RECOVERED signer (the address verify-vh derived from the bytes). A
//   revocation only affects the verdict when its `vendorAddress` EQUALS that subject; a revocation for some
//   OTHER key is `irrelevant`, never a downgrade.
//
// PURE + I/O-FREE on the decision; the FILE/DIR READ is the only I/O (readRevocationsFromPath), kept here so
//   verify-vh stays a thin wiring layer. No network, no key, no clock (the `asOf` instant is caller-supplied).
//
// PARITY WITH THE PRODUCER STACK
//   The decision semantics (applies / later / irrelevant / ignored; the inclusive `revokedAt <= asOf`
//   boundary; the EARLIEST-applicable governing record; the later-revoked informational note) mirror
//   cli/core/trust-asof.js, and the STRUCTURAL validation (validateSignedRevocation in ./revocation-core.js)
//   mirrors the producer's cli/core/attestation.js validateSignedAttestation + cli/core/revocation.js
//   validateRevocation gate-for-gate: the closed embedded field set, the supported schemaVersion (container
//   AND payload), the standing trust NOTES, the lowercase-only signature/address grammar, and the
//   WRAP-DON'T-EDIT canonical re-serialization binding. A revocation the producer IGNORES (a non-canonical /
//   extra-field / wrong-note / unsupported-schemaVersion / mixed-case-hex but genuinely self-signed one) is
//   therefore IGNORED here too — so on identical inputs verify-vh's verdict + exit code match
//   `vh ... verify-signed --revocations` byte-for-byte, for the SOUND inputs AND the malformed ones.
//   test/verifier.revocation.test.js pins that parity against the REAL producer core, including the
//   malformed-but-self-signed (NEGATIVE-parity) classes.

const fs = require("fs");
const path = require("path");

const core = require("./revocation-core");

const { RevocationReadError, isPlainObject, resolveAsOf, normalizeRevocationsInput, applyToVerifyResult } = core;

// ---------------------------------------------------------------------------
// FILE-OR-DIR reader. The ONLY I/O in this module. A counterparty may hand the verifier a SINGLE revocation
// file (one container, or a JSON array of them) OR a DIRECTORY of revocation files — a vendor commonly
// publishes one file per revoked key. Reading a directory aggregates every entry into ONE array of parsed
// containers, so the as-of decision sees them all under one --revocations flag.
//
// DIRECTORY MODE: read every *.json / *.vhrevocation.json file in the dir (NON-recursive — a flat folder of
// revocations), parse each, and flatten (a file that is itself a JSON array contributes all its entries). A
// file that is not valid JSON, or whose JSON is not an object/array, becomes a `_parseError` marker so it is
// IGNORED with a warning downstream — a single junk file in the folder never aborts the decision.
//
// FILE MODE: read the one file's text and hand it to normalizeRevocationsInput (so a single file may be one
// container OR a JSON array). A non-JSON single file HARD-errors (the recipient pointed --revocations at
// bytes that aren't a revocations input at all) — same contract as the producer's single-file read.
// ---------------------------------------------------------------------------

// File extensions a directory scan treats as candidate revocation files.
const REVOCATION_FILE_RE = /\.(json|vhrevocation\.json)$/i;

/**
 * Read the --revocations <file-or-dir> path into a normalized array of parsed entries (each a container
 * object or a `_parseError` marker). The caller passes the already-resolved array straight to
 * evaluateTrustAsOf/applyToVerifyResult.
 *
 * @param {string} p the --revocations path (a file or a directory)
 * @param {{ readFile?: Function, statSync?: Function, readdirSync?: Function }} [io] injectable fs for tests
 * @returns {Array<object>} a flat array of parsed entries (containers or `_parseError` markers)
 * @throws {RevocationReadError} on an unreadable path or a non-JSON SINGLE file
 */
function readRevocationsFromPath(p, io = {}) {
  const readFile = io.readFile || ((f) => fs.readFileSync(f, "utf8"));
  const statSync = io.statSync || ((f) => fs.statSync(f));
  const readdirSync = io.readdirSync || ((d) => fs.readdirSync(d));

  let st;
  try {
    st = statSync(p);
  } catch (e) {
    throw new RevocationReadError(`cannot read --revocations ${p}: ${e.message}`);
  }

  if (st.isDirectory()) {
    let names;
    try {
      names = readdirSync(p);
    } catch (e) {
      throw new RevocationReadError(`cannot read --revocations directory ${p}: ${e.message}`);
    }
    // Deterministic order (sorted) so the governing tie-break + ignored-warning order are stable.
    const files = names
      .filter((n) => REVOCATION_FILE_RE.test(n))
      .sort()
      .map((n) => path.join(p, n));
    const entries = [];
    for (const f of files) {
      let text;
      try {
        text = readFile(f);
      } catch (e) {
        entries.push({ _parseError: `cannot read ${path.basename(f)}: ${e.message}`, _raw: f });
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        entries.push({ _parseError: `${path.basename(f)} is not valid JSON: ${e.message}`, _raw: f });
        continue;
      }
      // A file may itself be a single container OR a JSON array of them — flatten either into the pool.
      if (Array.isArray(parsed)) {
        for (const el of parsed) entries.push(el);
      } else if (isPlainObject(parsed)) {
        entries.push(parsed);
      } else {
        entries.push({ _parseError: `${path.basename(f)} is not a revocation object/array`, _raw: f });
      }
    }
    return entries;
  }

  // Single file: read its text and normalize (a non-JSON single file HARD-errors via normalizeRevocationsInput).
  let text;
  try {
    text = readFile(p);
  } catch (e) {
    throw new RevocationReadError(`cannot read --revocations ${p}: ${e.message}`);
  }
  return normalizeRevocationsInput(text);
}

/**
 * The ONE shared integration verify-vh calls: read the --revocations file-or-dir, resolve the --as-of
 * (defaulting to nowISO), evaluate the decision, and fold it onto the verify result. Runs ONLY when
 * `revocationsPath` is truthy; with no path it returns the result UNCHANGED + a null decision (the
 * regression-safety contract — with no --revocations the verifier is byte-identical to today).
 *
 * @param {object} params { result, revocationsPath, asOf, nowISO, io? }
 * @returns {{ result, decision, defaulted }}
 */
function loadAndApply(params) {
  if (!isPlainObject(params) || !isPlainObject(params.result)) {
    throw new RevocationReadError("loadAndApply requires { result, revocationsPath, asOf, nowISO }");
  }
  const { result, revocationsPath, asOf, nowISO, io } = params;
  if (!revocationsPath) {
    return { result, decision: null, defaulted: false };
  }
  const { asOf: effectiveAsOf, defaulted } = resolveAsOf(asOf, nowISO);
  const entries = readRevocationsFromPath(revocationsPath, io || {});
  const out = applyToVerifyResult({ result, revocations: entries, asOf: effectiveAsOf });
  return { result: out, decision: out.trustAsOf, defaulted };
}

module.exports = {
  RevocationReadError: core.RevocationReadError,
  SIGNED_REVOCATION_KIND: core.SIGNED_REVOCATION_KIND,
  REVOCATION_KIND: core.REVOCATION_KIND,
  REVOCATION_SCHEMA_VERSION: core.REVOCATION_SCHEMA_VERSION,
  SUPPORTED_REVOCATION_SCHEMA_VERSIONS: core.SUPPORTED_REVOCATION_SCHEMA_VERSIONS,
  SUPPORTED_SIGNED_REVOCATION_SCHEMA_VERSIONS: core.SUPPORTED_SIGNED_REVOCATION_SCHEMA_VERSIONS,
  REVOCATION_REASON_SET: core.REVOCATION_REASON_SET,
  REVOCATION_FIELDS: core.REVOCATION_FIELDS,
  REVOCATION_TRUST_NOTE: core.REVOCATION_TRUST_NOTE,
  SIGNED_REVOCATION_TRUST_NOTE: core.SIGNED_REVOCATION_TRUST_NOTE,
  ISO_INSTANT_RE: core.ISO_INSTANT_RE,
  UNRECOVERABLE: core.UNRECOVERABLE,
  parseCanonicalInstant: core.parseCanonicalInstant,
  resolveAsOf: core.resolveAsOf,
  serializeRevocation: core.serializeRevocation,
  validateSignedRevocation: core.validateSignedRevocation,
  verifyRevocation: core.verifyRevocation,
  normalizeRevocationsInput: core.normalizeRevocationsInput,
  classifyRevocation: core.classifyRevocation,
  evaluateTrustAsOf: core.evaluateTrustAsOf,
  applyToVerifyResult: core.applyToVerifyResult,
  renderTrustAsOf: core.renderTrustAsOf,
  readRevocationsFromPath,
  loadAndApply,
};

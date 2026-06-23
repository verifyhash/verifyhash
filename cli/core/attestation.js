"use strict";

// cli/core/attestation.js — the GENERIC signed-attestation ENVELOPE engine for the product family.
//
// WHY THIS EXISTS
//   Every verifyhash provenance product (DataLedger, ProofParcel, AttestKit later) needs the SAME thing
//   once it has a canonical UNSIGNED identity payload: a way to WRAP that payload in a detached
//   signature WITHOUT editing it, then re-read and cryptographically verify the wrap. The container
//   builder/reader, the supported `scheme` list, the signer-recovery, and the wrap-don't-edit invariant
//   are IDENTICAL across products; only the container `kind` and the in-band trust `note` differ. This
//   module is the SINGLE, tested implementation of that envelope machinery; each product is a THIN
//   adapter that supplies its OWN container `kind`/`note` plus its OWN unsigned payload validator +
//   serializer (so the core stays product-agnostic and never requires a product module — no back-edge).
//
// THE SCHEME (detached, NOT EIP-712)
//   `eip191-personal-sign` means: the signer ran `personal_sign` (EIP-191) over the EXACT canonical
//   unsigned bytes (the UTF-8 of the embedded `attestation` string, including its single trailing
//   newline). A detached signature — NOT EIP-712 typed data — so the signed message IS the canonical
//   payload bytes verbatim, with no separate domain/struct encoding to drift from them.
//
// WRAP-DON'T-EDIT INVARIANT
//   The embedded UNSIGNED payload is re-parsed and re-validated by the PRODUCT's own unsigned validator
//   (injected as `cfg.validateUnsigned`), and the embedded string is required byte-for-byte equal to
//   `cfg.serializeUnsigned(embedded)` — so wrapping adds a vouch, it NEVER edits the thing vouched for,
//   and the bytes that were signed are unambiguous.

const { verifyMessage, getAddress } = require("ethers");

// The detached signature schemes this build understands. Each is an EXPLICIT, documented value so a
// reader knows EXACTLY what bytes were signed and how. `eip191-personal-sign` = EIP-191 personal_sign
// over the canonical UNSIGNED attestation bytes (a 65-byte r||s||v secp256k1 signature). Shared across
// the whole product family so the supported-scheme set can never diverge between products.
const SIGNED_ATTESTATION_SCHEMES = Object.freeze(["eip191-personal-sign"]);

// A 0x-prefixed, 0x-only, EVEN-length, non-empty hex string for the signature. eip191-personal-sign is
// specifically a 65-byte (r||s||v) secp256k1 signature -> exactly 130 hex chars. Strict by scheme below.
//
// CANONICAL CASE (byte-determinism). These accept ONLY lowercase hex. The signature block is the
// HUMAN-supplied part of the container and the part most likely to arrive EIP-55-checksummed (mixed
// case) or upper-cased. If we accepted mixed case and round-tripped it verbatim, two structurally
// identical containers over the SAME logical signature would serialize to DIFFERENT bytes — breaking the
// byte-determinism a future indexer/UI keys on. We REJECT non-canonical case on read/validate (rather
// than silently normalizing) so the wire format ossifies with one — and only one — byte encoding.
const HEXSTR_RE = /^0x([0-9a-f]{2})+$/;
const EIP191_SIG_RE = /^0x[0-9a-f]{130}$/; // 65 bytes: r(32) || s(32) || v(1)

// A claimed 0x-address: 0x + 40 LOWERCASE hex chars. The container records the CLAIMED signer; the
// recovery step (recoverSigner below) derives the actual signer from the signature. Lowercase-only for
// the same byte-determinism reason as the signature value: an EIP-55-checksummed (mixed-case) signer is
// the canonical address in a DIFFERENT encoding, so accepting it verbatim would let the same signer
// serialize two ways. A caller holding a checksummed address lowercases it before building the container.
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/**
 * Internal: assert a product passed a structurally complete signed-container config. The injected
 * `validateUnsigned`/`serializeUnsigned` are how the core enforces the wrap-don't-edit invariant WITHOUT
 * knowing anything product-specific (so there is no `require("../dataset")` back-edge).
 */
function _requireCfg(cfg) {
  if (!cfg || typeof cfg !== "object") {
    throw new Error("attestation core requires a { kind, schemaVersion, supportedSchemaVersions, note, validateUnsigned, serializeUnsigned } config");
  }
  if (typeof cfg.kind !== "string" || cfg.kind.length === 0) {
    throw new Error("attestation core config requires a non-empty string `kind`");
  }
  if (!Array.isArray(cfg.supportedSchemaVersions) || cfg.supportedSchemaVersions.length === 0) {
    throw new Error("attestation core config requires a non-empty `supportedSchemaVersions` array");
  }
  if (typeof cfg.note !== "string") {
    throw new Error("attestation core config requires a string `note` (the in-band trust caveat)");
  }
  if (typeof cfg.validateUnsigned !== "function" || typeof cfg.serializeUnsigned !== "function") {
    throw new Error(
      "attestation core config requires `validateUnsigned` and `serializeUnsigned` functions (the product's UNSIGNED payload codec)"
    );
  }
  if (typeof cfg.label !== "string" && cfg.label !== undefined) {
    throw new Error("attestation core config `label`, when present, must be a string");
  }
}

/**
 * Strictly validate a parsed SIGNED-attestation container against a product's framing. Throws an Error
 * describing the FIRST problem; never mutates and never fills defaults. REJECTS: a wrong kind/
 * schemaVersion, a wrong `note`, a non-string embedded `attestation`, a missing/non-object `signature`
 * block, an unknown `scheme`, a malformed `signer` address, a missing/!hex `signature` value, or an
 * embedded `attestation` that does not re-validate as a sound UNSIGNED payload (i.e. it must STILL be
 * signed:false/signature:null — wrapping never edits). It NEVER half-accepts.
 *
 * @param {any} obj
 * @param {object} cfg  the product's signed-container framing (see buildSignedAttestation)
 * @returns {object} the same object, if valid
 */
function validateSignedAttestation(obj, cfg) {
  _requireCfg(cfg);
  const label = cfg.label || "signed dataset attestation";
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error(`${label} must be a JSON object`);
  }
  if (obj.kind !== cfg.kind) {
    throw new Error(
      `not a verifyhash ${label} (kind: ${JSON.stringify(obj.kind)}; expected ` +
        `${JSON.stringify(cfg.kind)})`
    );
  }
  if (!cfg.supportedSchemaVersions.includes(obj.schemaVersion)) {
    throw new Error(
      `unsupported ${label} schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands ${JSON.stringify(cfg.supportedSchemaVersions)})`
    );
  }
  if (obj.note !== cfg.note) {
    throw new Error(`${label} note must be the standing SIGNED_ATTESTATION_TRUST_NOTE`);
  }
  // The embedded UNSIGNED payload is carried as the EXACT canonical bytes serializeUnsigned emits — a
  // STRING, so the signed-over bytes are unambiguous. Re-parse and re-validate it with the PRODUCT's
  // strict unsigned validator: it must STILL be signed:false/signature:null. This is the wrap-don't-edit
  // invariant — a signed container can never smuggle an edited or already-"signed" payload.
  if (typeof obj.attestation !== "string") {
    throw new Error(
      `${label} must embed the canonical UNSIGNED attestation as a string \`attestation\``
    );
  }
  let embedded;
  try {
    embedded = JSON.parse(obj.attestation);
  } catch (e) {
    throw new Error(`embedded attestation is not valid JSON: ${e.message}`);
  }
  // Re-validate the embedded payload by the PRODUCT's unsigned validator (throws on signed:true etc.).
  cfg.validateUnsigned(embedded);
  // Re-serialize the embedded payload and require the embedded STRING to be byte-identical to the
  // canonical form. This pins the embedded bytes to EXACTLY what serializeUnsigned emits — the bytes
  // that were signed over — so no insignificant-whitespace / reordered variant can sneak in.
  if (obj.attestation !== cfg.serializeUnsigned(embedded)) {
    throw new Error(
      "embedded attestation is not in canonical form (the signed-over bytes must be byte-for-byte " +
        "serializeAttestation's output)"
    );
  }

  const sig = obj.signature;
  if (sig == null || typeof sig !== "object" || Array.isArray(sig)) {
    throw new Error(`${label} signature must be a { scheme, signer, signature } object`);
  }
  if (!SIGNED_ATTESTATION_SCHEMES.includes(sig.scheme)) {
    throw new Error(
      `unknown signature scheme: ${JSON.stringify(sig.scheme)} ` +
        `(this build understands ${JSON.stringify(SIGNED_ATTESTATION_SCHEMES)})`
    );
  }
  if (typeof sig.signer !== "string" || !ADDRESS_RE.test(sig.signer)) {
    throw new Error(
      `signature signer must be a 0x-prefixed 20-byte LOWERCASE-hex address ` +
        `(checksummed/mixed-case rejected for byte-determinism — lowercase it first), got: ${String(sig.signer)}`
    );
  }
  if (typeof sig.signature !== "string" || !HEXSTR_RE.test(sig.signature)) {
    throw new Error(
      `signature value must be a 0x-prefixed LOWERCASE-hex string ` +
        `(mixed/upper case rejected for byte-determinism), got: ${String(sig.signature)}`
    );
  }
  // Per-scheme shape: eip191-personal-sign is a 65-byte r||s||v secp256k1 signature.
  if (sig.scheme === "eip191-personal-sign" && !EIP191_SIG_RE.test(sig.signature)) {
    throw new Error(
      `eip191-personal-sign signature must be a 65-byte (r||s||v) 0x-hex string, got length ${sig.signature.length}`
    );
  }
  return obj;
}

/**
 * Assemble + validate a SIGNED-attestation container from a validated UNSIGNED payload and a detached
 * signature triple, PARAMETERIZED by the product's container framing. PURE: it performs NO signing and
 * NO key handling — the loop never holds a key. It embeds the EXACT canonical unsigned bytes
 * (cfg.serializeUnsigned(attestation)) as a string so the signed-over bytes are unambiguous, then
 * attaches { scheme, signer, signature } and strictly validates the whole container.
 *
 * @param {object} params
 * @param {object} params.attestation a validated UNSIGNED payload (re-validated via cfg.validateUnsigned)
 * @param {string} params.scheme      one of SIGNED_ATTESTATION_SCHEMES (e.g. "eip191-personal-sign")
 * @param {string} params.signer      the claimed 0x-address of the signer
 * @param {string} params.signature   the 0x-hex detached signature over cfg.serializeUnsigned(attestation)
 * @param {object} cfg                the product's signed-container framing
 * @returns {object} a validated signed-attestation container
 */
function buildSignedAttestation(params, cfg) {
  _requireCfg(cfg);
  if (!params || typeof params !== "object") {
    throw new Error("buildSignedAttestation requires { attestation, scheme, signer, signature }");
  }
  const { attestation, scheme, signer, signature } = params;
  // The embedded payload must itself be a sound UNSIGNED payload before we wrap it (re-validate so a
  // programmatic caller that hand-built one is checked too). validateUnsigned rejects signed:true.
  cfg.validateUnsigned(attestation);
  // Embed the EXACT canonical bytes — the string serializeUnsigned emits — so the signed-over bytes are
  // byte-for-byte unambiguous.
  const container = {
    kind: cfg.kind,
    schemaVersion: cfg.schemaVersion,
    note: cfg.note,
    attestation: cfg.serializeUnsigned(attestation),
    signature: { scheme, signer, signature },
  };
  validateSignedAttestation(container, cfg);
  return container;
}

/**
 * Sign a validated UNSIGNED payload with a caller-supplied signer and WRAP it into a validated signed
 * container — the single, tested place that turns a payload + key-holder into the detached-signature
 * envelope, parameterized by the product's framing.
 *
 * KEY HYGIENE (why a signer OBJECT, never a raw key). This helper takes an ethers signer-like object
 * (exposing async `getAddress()` + `signMessage(bytes|string)` — e.g. an ethers `Wallet`). It NEVER
 * accepts a raw private-key string, NEVER persists a key, and NEVER logs one: the key lives only inside
 * the caller's signer object. Loading a key from a keystore/env/HSM and constructing that signer is the
 * CLI layer's job (T-19.2); this core stays key-agnostic.
 *
 * WHAT IS SIGNED (byte-for-byte). It re-validates the unsigned payload via `cfg.validateUnsigned` and
 * serializes it to the EXACT canonical bytes with `cfg.serializeUnsigned` — the SAME string
 * `recoverSigner` later runs `verifyMessage` over (including the trailing newline). It then runs
 * `signer.signMessage(canonicalBytes)` (EIP-191 personal_sign), reads `signer.getAddress()`, lowercases
 * it, and routes the triple through the EXISTING `buildSignedAttestation` so the container is assembled
 * AND strictly validated by the one shared path (no new container assembly here). The result therefore
 * ROUND-TRIPS by construction: verifySignedAttestation recovers exactly this signer over exactly these
 * bytes, and binding against `cfg.serializeUnsigned(attestation)` passes.
 *
 * The embedded UNSIGNED payload is WRAPPED, never edited — it stays signed:false/signature:null (the
 * wrap-don't-edit invariant, enforced by buildSignedAttestation re-validating it).
 *
 * @param {object} params
 * @param {object} params.attestation a validated UNSIGNED payload (re-validated via cfg.validateUnsigned)
 * @param {object} params.signer      an ethers signer-like object: async getAddress() + signMessage(bytes|string)
 * @param {object} cfg                the product's signed-container framing
 * @returns {Promise<object>} the validated signed-attestation container
 */
async function signAttestation(params, cfg) {
  _requireCfg(cfg);
  if (!params || typeof params !== "object") {
    throw new Error("signAttestation requires { attestation, signer }");
  }
  const { attestation, signer } = params;
  if (!signer || (typeof signer !== "object" && typeof signer !== "function")) {
    throw new Error(
      "signAttestation requires a `signer` object exposing getAddress() + signMessage() (e.g. an ethers Wallet); a raw private-key string is NOT accepted"
    );
  }
  if (typeof signer.getAddress !== "function" || typeof signer.signMessage !== "function") {
    throw new Error(
      "signAttestation `signer` must expose getAddress() and signMessage() (an ethers signer-like object)"
    );
  }
  // (a) Re-validate the unsigned payload and serialize it to the EXACT canonical bytes — the same string
  //     recoverSigner runs verifyMessage over (byte-for-byte, including the trailing newline). We validate
  //     FIRST so we never ask the signer to sign a malformed/already-"signed" payload.
  cfg.validateUnsigned(attestation);
  const canonicalBytes = cfg.serializeUnsigned(attestation);
  // (b) EIP-191 personal_sign over exactly those bytes. The key never leaves the signer object.
  const signature = await signer.signMessage(canonicalBytes);
  // (c) Read the signer's address, lowercase it (the container records the CLAIMED signer in canonical
  //     lowercase), and route through the EXISTING builder so the container is assembled AND strictly
  //     validated by the one shared path — no separate container assembly here.
  const signerAddress = (await signer.getAddress()).toLowerCase();
  return buildSignedAttestation(
    { attestation, scheme: "eip191-personal-sign", signer: signerAddress, signature },
    cfg
  );
}

/**
 * Serialize a signed-attestation container to its canonical, byte-deterministic bytes: a FIXED top-level
 * (and signature-block) key order, NO insignificant whitespace, a single trailing newline. Two runs over
 * the same inputs produce an identical string.
 * @param {object} container a validated signed-attestation container
 * @param {object} cfg       the product's signed-container framing
 * @returns {string} the canonical serialization (newline-terminated)
 */
function serializeSignedAttestation(container, cfg) {
  validateSignedAttestation(container, cfg);
  const canonical = {
    kind: container.kind,
    schemaVersion: container.schemaVersion,
    note: container.note,
    // The embedded canonical UNSIGNED bytes (a string) — JSON.stringify escapes it, preserving the exact
    // bytes including the embedded trailing newline.
    attestation: container.attestation,
    signature: {
      scheme: container.signature.scheme,
      signer: container.signature.signer,
      signature: container.signature.signature,
    },
  };
  return JSON.stringify(canonical) + "\n";
}

/**
 * Read, parse, and STRICTLY validate the signed-attestation container at `signedPath` against a
 * product's framing. Round-trips with serializeSignedAttestation. Throws on a missing file or invalid
 * JSON too. The `label` (default "signed dataset attestation") parameterizes only the human noun in the
 * I/O error messages so DataLedger's strings stay byte-identical.
 *
 * @param {string} signedPath
 * @param {object} cfg  the product's signed-container framing
 * @returns {object} the validated container
 */
function readSignedAttestation(signedPath, cfg) {
  _requireCfg(cfg);
  const fs = require("fs");
  const label = cfg.label || "signed dataset attestation";
  if (!signedPath || typeof signedPath !== "string") {
    throw new Error("readSignedAttestation requires a signed attestation file path");
  }
  let raw;
  try {
    raw = fs.readFileSync(signedPath, "utf8");
  } catch (e) {
    throw new Error(`cannot read ${label} at ${signedPath}: ${e.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${label} at ${signedPath} is not valid JSON: ${e.message}`);
  }
  return validateSignedAttestation(obj, cfg);
}

/**
 * Recover the signing address from a signed-attestation container's embedded canonical bytes + signature
 * per the declared `scheme`. PURE: no I/O, no key, no network. For `eip191-personal-sign` this is ethers'
 * `verifyMessage(<embedded canonical bytes>, signature)` — EIP-191 personal_sign recovery over the EXACT
 * bytes that were signed. Returns the recovered address as a LOWERCASE 0x-hex string. Throws on an
 * unknown scheme (defense-in-depth: validateSignedAttestation already rejects one) or an unrecoverable
 * signature. Product-agnostic — the embedded bytes are whatever the container carries.
 *
 * @param {object} container a validated signed-attestation container
 * @returns {string} the recovered signer address, 0x-prefixed lowercase
 */
function recoverSigner(container) {
  const { scheme, signature } = container.signature;
  if (scheme === "eip191-personal-sign") {
    // The signed message IS the embedded canonical UNSIGNED bytes verbatim (the string, including its
    // single trailing newline). verifyMessage runs EIP-191 personal_sign recovery over exactly those bytes.
    const recovered = verifyMessage(container.attestation, signature);
    return recovered.toLowerCase();
  }
  throw new Error(
    `cannot recover signer for unknown signature scheme: ${JSON.stringify(scheme)} ` +
      `(this build understands ${JSON.stringify(SIGNED_ATTESTATION_SCHEMES)})`
  );
}

/**
 * Verify (purely, OFFLINE) a signed-attestation container: recover the signer from the embedded canonical
 * bytes + signature and confirm it equals the container's CLAIMED `signer`; OPTIONALLY pin it to an
 * EXPECTED signer (`expectedSigner`); OPTIONALLY confirm the signature binds a caller's own item
 * (`expectedCanonical` — the canonical UNSIGNED bytes the caller recomputed from their own data) by
 * requiring them byte-identical to the embedded payload. The verdict is ACCEPTED only when EVERY
 * requested check passes.
 *
 * No I/O, no provider, no key, no network. Throws only on an unrecoverable signature when the scheme is
 * unknown; a recovered address that simply doesn't match is a clean REJECTED (a normal verdict).
 *
 * This is the GENERIC verify core. Products supply the canonical bytes to bind against (computed from
 * THEIR own item) rather than the core knowing how to build them.
 *
 * @param {object} params
 * @param {object} params.container          a validated signed-attestation container
 * @param {string} [params.expectedSigner]   OPTIONAL expected signer 0x-address; checked when present
 * @param {string} [params.expectedCanonical] OPTIONAL canonical UNSIGNED bytes to bind; checked when present
 * @returns {{
 *   verdict: "ACCEPTED"|"REJECTED",
 *   accepted: boolean,
 *   recoveredSigner: string,
 *   claimedSigner: string,
 *   scheme: string,
 *   checks: {
 *     signatureMatchesSigner: boolean,
 *     signerMatchesExpected: boolean|null,
 *     manifestBindsAttestation: boolean|null,
 *   },
 *   expectedSigner: string|null,
 *   manifestChecked: boolean,
 *   failedChecks: string[],
 * }}
 */
function verifySignedAttestation(params) {
  if (!params || typeof params !== "object") {
    throw new Error("verifySignedAttestation requires { container, [expectedSigner], [expectedCanonical] }");
  }
  const { container, expectedSigner, expectedCanonical } = params;

  const claimedSigner = container.signature.signer; // validated lowercase 0x-address
  const scheme = container.signature.scheme;

  // (b) Recover the signer from the embedded canonical bytes + signature, and confirm it equals the
  //     container's CLAIMED `signer`. A signature that does not recover to the claimed signer means the
  //     `signer` label is unbacked — a clean check failure (REJECTED), not an error.
  //
  //     A TAMPERED signature can be not merely WRONG but UNRECOVERABLE: a corrupted (r,s,v) may have no
  //     valid secp256k1 point, in which case ethers' verifyMessage throws. That is still a caller-facing
  //     REJECTED verdict, NOT a crash — so we catch it and treat it as a failed signature check (the
  //     recovered signer is the explicit "(unrecoverable)" sentinel, never a real address). An unknown
  //     scheme is a different (structural) failure and is re-thrown — validateSignedAttestation already
  //     rejects it, so this is defense-in-depth that should never fire for a read container.
  let recoveredSigner;
  let signatureMatchesSigner;
  try {
    recoveredSigner = recoverSigner(container);
    signatureMatchesSigner = recoveredSigner === claimedSigner.toLowerCase();
  } catch (e) {
    if (/unknown signature scheme/.test(e.message)) throw e;
    recoveredSigner = "(unrecoverable)";
    signatureMatchesSigner = false;
  }

  // (c) OPTIONAL pin: confirm the recovered signer equals the EXPECTED address the caller pinned.
  //     Normalize the expected address (accept checksummed/mixed-case via getAddress, then lowercase) so a
  //     caller can paste an EIP-55 address. null = not requested.
  let signerMatchesExpected = null;
  let normalizedExpected = null;
  if (expectedSigner !== undefined && expectedSigner !== null) {
    normalizedExpected = getAddress(expectedSigner).toLowerCase();
    // Pin against the RECOVERED signer (not the merely-claimed one): the caller pins WHO actually signed.
    signerMatchesExpected = recoveredSigner === normalizedExpected;
  }

  // (d) OPTIONAL binding: require the caller-supplied canonical UNSIGNED bytes byte-identical to the
  //     embedded (signed-over) payload. This proves the signature binds the item the caller actually
  //     holds, not some other one. null = not requested.
  let manifestBindsAttestation = null;
  if (expectedCanonical !== undefined && expectedCanonical !== null) {
    manifestBindsAttestation = expectedCanonical === container.attestation;
  }

  // Verdict: ACCEPTED only when EVERY REQUESTED check passes. The signature-vs-signer check is ALWAYS
  // requested; the other two only when their flag was given (null = not requested, never fails the gate).
  const failedChecks = [];
  if (!signatureMatchesSigner) failedChecks.push("signatureMatchesSigner");
  if (signerMatchesExpected === false) failedChecks.push("signerMatchesExpected");
  if (manifestBindsAttestation === false) failedChecks.push("manifestBindsAttestation");
  const accepted = failedChecks.length === 0;

  return {
    verdict: accepted ? "ACCEPTED" : "REJECTED",
    accepted,
    recoveredSigner,
    claimedSigner: claimedSigner.toLowerCase(),
    scheme,
    checks: {
      signatureMatchesSigner,
      signerMatchesExpected,
      manifestBindsAttestation,
    },
    expectedSigner: normalizedExpected,
    manifestChecked: manifestBindsAttestation !== null,
    failedChecks,
  };
}

module.exports = {
  SIGNED_ATTESTATION_SCHEMES,
  validateSignedAttestation,
  buildSignedAttestation,
  signAttestation,
  serializeSignedAttestation,
  readSignedAttestation,
  recoverSigner,
  verifySignedAttestation,
};

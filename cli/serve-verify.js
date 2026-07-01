"use strict";

// cli/serve-verify.js — the PURE, transport-agnostic verify CORE for the `vh serve-verify` service (T-59.1).
//
// WHAT THIS IS
//   `verifyRequest(body)` takes a single, already-parsed request OBJECT (whatever a transport — an HTTP
//   handler, a queue worker, a test — hands it) and returns a stable, versioned verdict OBJECT. It NEVER
//   throws, NEVER touches the network, NEVER touches the filesystem, NEVER signs, and holds NO key. It is
//   the composition layer that lets a CI pipeline / another microservice send "here is a seal (or a signed
//   container), tell me ACCEPT/REJECT" over ANY transport, by dispatching on the request's `kind` to the
//   already-green, already-tested SDK verify cores:
//
//     kind "verify-seal"        -> evidence.verifySeal(seal, entries)          (UNSIGNED tamper-evidence)
//     kind "verify-signed-seal" -> evidence.verifySignedSeal({container, ...}) (SIGNED / vendor-pinned)
//
//   It re-uses the EXISTING verdict field names VERBATIM (it spreads the core verdict into `verdict.detail`
//   unchanged) so a downstream consumer depends on ONE stable shape across the CLI, the SDK, and this
//   service. It adds only a THIN, versioned request-level envelope (`schema`, `service`, `outcome`) around
//   that core verdict — it invents NO new crypto, NO new verify logic, NO new verdict vocabulary.
//
// PURITY (asserted by the tests — a grep proves NONE of these appear in this module)
//   NO `require("http")` / `require("https")` / `require("net")` / `require("fs")` / `require("dns")`.
//   NO key material: it never calls `Wallet.createRandom`, never reads a private key, never signs. The
//   ONLY dependency is `./evidence` (the SDK cores), and the ONLY core functions it calls are the PURE,
//   filesystem-free verify/parse/build helpers (verifySeal / verifySignedSeal / readSeal /
//   validateSignedSeal / buildSeal / serializeSeal) — none of which read a file, open a socket, or need a
//   key. The function is therefore drivable with the filesystem unavailable/irrelevant.
//
// TRANSPORT-AGNOSTIC (why the ENVELOPE, not raw bytes)
//   The transport (HTTP body, queue message, …) delivers TEXT/JSON, so `entries[].content` arrives as a
//   STRING with an explicit `encoding` ("utf8" | "base64" | "hex"). This module decodes that back into the
//   Buffer the byte-based cores require, RE-DERIVING the Merkle root from the caller-supplied bytes — never
//   from the seal's own stored hashes. So a one-byte tamper in `content` still flips ACCEPTED -> REJECTED,
//   exactly as the CLI does.
//
// FAIL CLOSED (never a silent/false ACCEPT)
//   Every malformed body, oversized body, unknown `kind`, undecodable entry, or unexpected internal error
//   maps to `verdict:"ERROR"` with a machine-readable `code` and a human `message` — NEVER `"ACCEPTED"`,
//   NEVER a thrown exception that could crash a server or be swallowed into a 200. An ERROR is the safe
//   default: a caller that cannot be verified must not be treated as verified.

const evidence = require("./evidence");

// The versioned envelope contract. Bump SCHEMA only on a breaking change to the ENVELOPE fields (never for
// a change inside `detail`, which tracks the core verify verdicts' own shape).
const VERIFY_REQUEST_SCHEMA = "vh.verify-request/1";
const SERVICE_NAME = "vh-serve-verify";

// The request `kind`s this core dispatches on (the REQUEST kind — distinct from the seal/container `kind`
// values `evidence.SEAL_KIND` / `evidence.SIGNED_SEAL_KIND` those payloads carry INSIDE the request).
const KIND_VERIFY_SEAL = "verify-seal";
const KIND_VERIFY_SIGNED_SEAL = "verify-signed-seal";
const SUPPORTED_KINDS = Object.freeze([KIND_VERIFY_SEAL, KIND_VERIFY_SIGNED_SEAL]);

// The three top-level verdicts. ERROR is NOT a content verdict — it means "the request could not be
// evaluated", strictly separate from a content REJECTED (which IS an evaluated, negative answer).
const VERDICT = Object.freeze({ ACCEPTED: "ACCEPTED", REJECTED: "REJECTED", ERROR: "ERROR" });

// Machine-readable ERROR codes (stable; a caller can branch on these without parsing prose).
const ERR = Object.freeze({
  NOT_OBJECT: "ERR_BODY_NOT_OBJECT",
  TOO_LARGE: "ERR_BODY_TOO_LARGE",
  UNKNOWN_KIND: "ERR_UNKNOWN_KIND",
  MISSING_SEAL: "ERR_MISSING_SEAL",
  BAD_SEAL: "ERR_BAD_SEAL",
  BAD_ENTRIES: "ERR_BAD_ENTRIES",
  MISSING_CONTAINER: "ERR_MISSING_CONTAINER",
  BAD_CONTAINER: "ERR_BAD_CONTAINER",
  BAD_EXPECTED_SIGNER: "ERR_BAD_EXPECTED_SIGNER",
  INTERNAL: "ERR_INTERNAL",
});

// A generous upper bound on the request size (bytes of the estimated payload), so a hostile/accidental
// giant body is a clean ERROR rather than an OOM. The transport can (and should) also cap the wire size;
// this is the core's own belt-and-braces. 8 MiB comfortably fits a large seal + its inlined content while
// staying far below anything that would strain the process.
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const SUPPORTED_ENTRY_ENCODINGS = Object.freeze(["utf8", "base64", "hex"]);

/**
 * The stable, versioned ERROR verdict envelope. Never contains an ACCEPTED/REJECTED content answer — an
 * ERROR means the request itself could not be evaluated. Pure; allocates a plain object only.
 * @param {string} code   one of ERR.*
 * @param {string} message a human-readable, non-sensitive reason
 * @returns {object}
 */
function errorVerdict(code, message) {
  return {
    schema: VERIFY_REQUEST_SCHEMA,
    service: SERVICE_NAME,
    verdict: VERDICT.ERROR,
    code: String(code),
    message: String(message),
  };
}

/**
 * The stable, versioned OK envelope wrapping a core verify verdict VERBATIM. `outcome` mirrors the core's
 * own `verdict` ("ACCEPTED"|"REJECTED") so a transport can map it to a status code without reading `detail`;
 * `detail` is the UNCHANGED core verdict object (its field names are the contract the CLI/SDK already ship).
 * @param {string} kind    the request kind that was dispatched
 * @param {object} detail  the core verdict from verifySeal / verifySignedSeal (spread unchanged)
 * @returns {object}
 */
function okVerdict(kind, detail) {
  // `detail.verdict` is the core's own field ("ACCEPTED"|"REJECTED"). We surface it at the top level as the
  // envelope's `verdict` too, so the top-level answer and the detail's answer are ALWAYS the same string —
  // a transport reads the top level; an auditor reads `detail`. We NEVER recompute or override it.
  const outcome = detail.verdict;
  return {
    schema: VERIFY_REQUEST_SCHEMA,
    service: SERVICE_NAME,
    verdict: outcome, // ACCEPTED | REJECTED — copied from the core verdict, never re-derived
    kind,
    detail, // the EXISTING core verdict shape, byte-for-byte (field names unchanged)
  };
}

// Rough byte-size of an already-parsed body without re-serializing giant nested structures repeatedly. We
// only need an UPPER-bound guard, so a single JSON.stringify is acceptable and stays pure (string in memory,
// no I/O). Guarded in a try/catch: a body with a circular ref or a BigInt can't be stringified — that is
// itself a malformed request, reported as an oversized/invalid error rather than a throw.
function estimateBodyBytes(body) {
  const json = JSON.stringify(body);
  // JSON.stringify returns undefined for a value that serializes to nothing (e.g. a function); treat that as
  // 0 here — the shape checks below will reject a non-object body anyway.
  return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}

/**
 * Decode one transport entry `{ relPath, content, encoding }` into the `{ relPath, bytes: Buffer }` shape
 * the byte-based seal core consumes. PURE: string -> Buffer, no I/O. Throws a plain Error (caught by the
 * caller and mapped to a clean ERROR verdict) on any malformed entry — NEVER partially accepts.
 */
function decodeEntry(entry, index) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`entries[${index}] must be an object { relPath, content, encoding }`);
  }
  const { relPath, content } = entry;
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error(`entries[${index}].relPath must be a non-empty string`);
  }
  if (typeof content !== "string") {
    throw new Error(`entries[${index}].content must be a string (the ${index}th entry's bytes, encoded)`);
  }
  const encoding = entry.encoding === undefined ? "utf8" : entry.encoding;
  if (!SUPPORTED_ENTRY_ENCODINGS.includes(encoding)) {
    throw new Error(
      `entries[${index}].encoding must be one of ${SUPPORTED_ENTRY_ENCODINGS.join("|")} (got ${JSON.stringify(encoding)})`
    );
  }
  // For base64/hex, Buffer.from is lenient (it drops invalid chars) — so we round-trip and require the
  // re-encoding to match, catching a corrupt/garbage payload instead of silently hashing truncated bytes.
  const bytes = Buffer.from(content, encoding);
  if (encoding === "base64" || encoding === "hex") {
    const reEncoded = bytes.toString(encoding);
    const normalizedInput = encoding === "hex" ? content.toLowerCase() : content;
    const normalizedOut = encoding === "hex" ? reEncoded.toLowerCase() : reEncoded;
    if (normalizedOut !== normalizedInput) {
      throw new Error(`entries[${index}].content is not valid ${encoding}`);
    }
  }
  return { relPath, bytes };
}

/** Decode a transport `entries[]` array into the byte-based entry list. Throws on any malformed member. */
function decodeEntries(rawEntries) {
  if (!Array.isArray(rawEntries)) {
    throw new Error("`entries` must be an array of { relPath, content, encoding }");
  }
  return rawEntries.map((e, i) => decodeEntry(e, i));
}

/**
 * verifyRequest(body) — the PURE, transport-agnostic verify dispatcher.
 *
 * @param {object} body an already-parsed request object:
 *   UNSIGNED:  { kind: "verify-seal", seal: <object|string>, entries: [{relPath, content, encoding}] }
 *   SIGNED:    { kind: "verify-signed-seal", container: <object|string>,
 *               expectedSigner?: <0x-address>, entries?: [{relPath, content, encoding}] }
 *              (when `entries` is supplied on the SIGNED path, it is BOUND: the canonical seal bytes are
 *               recomputed from those entries and required byte-identical to the signed payload; a set that
 *               does NOT match the signed bytes is a clean REJECTED, never an ACCEPT.)
 * @returns {object} a stable versioned envelope:
 *   OK:    { schema, service, verdict:"ACCEPTED"|"REJECTED", kind, detail:<core verdict, fields unchanged> }
 *   ERROR: { schema, service, verdict:"ERROR", code, message }
 *
 * NEVER throws. NEVER returns a false ACCEPT for a malformed/oversized/unknown request.
 */
function verifyRequest(body) {
  try {
    // --- Envelope-level guards (fail closed) --------------------------------------------------------
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return errorVerdict(ERR.NOT_OBJECT, "request body must be a JSON object");
    }
    let size;
    try {
      size = estimateBodyBytes(body);
    } catch (_) {
      // Un-stringifiable (circular ref / BigInt / etc.) — a malformed request, reported as too-large-ish.
      return errorVerdict(ERR.TOO_LARGE, "request body could not be measured (not plain JSON)");
    }
    if (size > MAX_BODY_BYTES) {
      return errorVerdict(
        ERR.TOO_LARGE,
        `request body is ${size} bytes; the limit is ${MAX_BODY_BYTES} bytes`
      );
    }

    const kind = body.kind;
    if (kind === KIND_VERIFY_SEAL) return verifySealRequest(body);
    if (kind === KIND_VERIFY_SIGNED_SEAL) return verifySignedSealRequest(body);
    return errorVerdict(
      ERR.UNKNOWN_KIND,
      `unknown request kind ${JSON.stringify(kind)}; expected one of ${SUPPORTED_KINDS.map((k) => JSON.stringify(k)).join(", ")}`
    );
  } catch (e) {
    // Defense-in-depth: anything unexpected inside a handler becomes a clean ERROR, never a crash or a
    // silent ACCEPT. The message is the error's own text (non-sensitive — no key/file/network here).
    return errorVerdict(ERR.INTERNAL, e && e.message ? String(e.message) : "internal error");
  }
}

/** Handle a { kind:"verify-seal", seal, entries } request. Pure — decodes entries, calls verifySeal. */
function verifySealRequest(body) {
  if (body.seal === undefined || body.seal === null) {
    return errorVerdict(ERR.MISSING_SEAL, "`seal` is required for kind \"verify-seal\"");
  }
  // Strictly parse+validate the seal FIRST (readSeal accepts a JSON string OR an object; it rejects a
  // corrupt/foreign/wrong-kind seal before any byte work — never half-accepted).
  let seal;
  try {
    seal = evidence.readSeal(body.seal);
  } catch (e) {
    return errorVerdict(ERR.BAD_SEAL, `invalid seal: ${e.message}`);
  }
  let entries;
  try {
    entries = decodeEntries(body.entries === undefined ? [] : body.entries);
  } catch (e) {
    return errorVerdict(ERR.BAD_ENTRIES, e.message);
  }
  // The authoritative, PURE verify — RE-DERIVES the root from the supplied bytes (a one-byte tamper flips it).
  const detail = evidence.verifySeal(seal, entries);
  return okVerdict(KIND_VERIFY_SEAL, detail);
}

/**
 * Handle a { kind:"verify-signed-seal", container, expectedSigner?, entries? } request. Pure — validates
 * the container, optionally recomputes the bound canonical bytes from `entries`, calls verifySignedSeal.
 */
function verifySignedSealRequest(body) {
  if (body.container === undefined || body.container === null) {
    return errorVerdict(ERR.MISSING_CONTAINER, "`container` is required for kind \"verify-signed-seal\"");
  }
  // Parse the container if it arrived as a JSON string; then STRICT-validate it (rejects a tampered/foreign
  // container — but NOT a forged signature, which the verify core catches by recovering the signer).
  let container = body.container;
  if (typeof container === "string") {
    try {
      container = JSON.parse(container);
    } catch (e) {
      return errorVerdict(ERR.BAD_CONTAINER, `container is not valid JSON: ${e.message}`);
    }
  }
  if (container === null || typeof container !== "object" || Array.isArray(container)) {
    return errorVerdict(ERR.BAD_CONTAINER, "`container` must be a signed-seal object or its JSON string");
  }
  try {
    evidence.validateSignedSeal(container);
  } catch (e) {
    return errorVerdict(ERR.BAD_CONTAINER, `invalid signed container: ${e.message}`);
  }

  // OPTIONAL pin: an expected signer address the recovered signer must equal. We pass it straight to the
  // core (which normalizes/validates the address); a malformed address is a clean ERROR here rather than a
  // throw from deep in the core.
  let expectedSigner;
  if (body.expectedSigner !== undefined && body.expectedSigner !== null) {
    if (typeof body.expectedSigner !== "string") {
      return errorVerdict(ERR.BAD_EXPECTED_SIGNER, "`expectedSigner` must be a 0x-address string");
    }
    expectedSigner = body.expectedSigner;
  }

  // OPTIONAL binding: when `entries` is supplied, recompute the canonical UNSIGNED seal bytes from THOSE
  // entries (the SAME serializeSeal(buildSeal(...)) the seal path embeds) and require them byte-identical to
  // the signed payload. So an `entries` set that does NOT match the signed bytes is a clean REJECTED — never
  // an ACCEPT. Absent `entries` = binding NOT requested (Check runs signature+optional-pin only).
  let expectedCanonical;
  if (body.entries !== undefined && body.entries !== null) {
    let entries;
    try {
      entries = decodeEntries(body.entries);
    } catch (e) {
      return errorVerdict(ERR.BAD_ENTRIES, e.message);
    }
    try {
      expectedCanonical = evidence.serializeSeal(evidence.buildSeal(entries));
    } catch (e) {
      // A set that can't even be sealed (e.g. duplicate relPaths) is a bad-entries request, not an ACCEPT.
      return errorVerdict(ERR.BAD_ENTRIES, `could not seal supplied entries: ${e.message}`);
    }
  }

  let detail;
  try {
    detail = evidence.verifySignedSeal({ container, expectedSigner, expectedCanonical });
  } catch (e) {
    // The core throws only on an unknown signature scheme (validateSignedSeal already rejects one, so this
    // is defense-in-depth) or a malformed expectedSigner address. Either is a request error, never an ACCEPT.
    return errorVerdict(ERR.BAD_EXPECTED_SIGNER, e.message);
  }
  return okVerdict(KIND_VERIFY_SIGNED_SEAL, detail);
}

module.exports = {
  verifyRequest,
  // Constants a transport / test can depend on without hard-coding strings.
  VERIFY_REQUEST_SCHEMA,
  SERVICE_NAME,
  KIND_VERIFY_SEAL,
  KIND_VERIFY_SIGNED_SEAL,
  SUPPORTED_KINDS,
  VERDICT,
  ERR,
  MAX_BODY_BYTES,
  SUPPORTED_ENTRY_ENCODINGS,
  // Exposed for tests / advanced transports that pre-decode; NOT part of the request envelope contract.
  decodeEntry,
  decodeEntries,
};

"use strict";

// cli/core/agent-session.js — the PURE agent-session evidence core (T-68.1, EPIC-68 "AgentTrace").
//
// WHAT THIS IS
//   A transport/filesystem-agnostic core that turns an ORDERED log of AI-agent session events
//   (prompts, completions, tool calls/results, notes) into tamper-evident, selectively-REDACTABLE
//   evidence. It provides:
//
//     (a) a CANONICAL EVENT SCHEMA
//             { seq, ts, actor, type, payload | payloadHash, redacted?, meta? }
//         with `type` drawn from a CLOSED set (EVENT_TYPES) and STRICT validation: every failure
//         is a NAMED reject `{ ok:false, reason, field? }` with a stable reason code (REASONS) —
//         missing/extra/malformed fields, non-contiguous `seq`, non-string `ts`. Nothing here ever
//         throws on hostile input.
//
//     (b) the REDACTION-SAFE LEAF — the design decision that makes this evidentiary. Each event's
//         Merkle leaf is computed over the canonical event with the payload represented by its
//         HASH COMMITMENT:
//             payloadHash = hashBytes(utf8(payload))        // cli/hash.js keccak256, verbatim
//             leaf = hashBytes(utf8(JSON.stringify([
//                      LEAF_DOMAIN, seq, ts, actor, type, payloadHash, canonicalMetaJson|null ])))
//         The payload bytes are NEVER in the leaf preimage — only their commitment is. So a FULL
//         event (carrying `payload`) and its REDACTED twin (carrying only `payloadHash`, flagged
//         `redacted: true`) derive the IDENTICAL leaf, and redacting ANY subset of a session's
//         events changes NEITHER the leaves NOR the root. Verification recomputes `payloadHash`
//         from `payload` when it is present (and cross-checks a carried `payloadHash` against it);
//         when the payload is absent the well-formed commitment itself is what the tree binds.
//         The fixed-position JSON array + JSON string escaping make the encoding unambiguous: no
//         two distinct canonical events serialize to the same preimage.
//
//     (c) the ORDERED LOG: sessionHead(events) -> { ok, size, root } via cli/journal-log.js
//         treeHead over the event leaves REUSED VERBATIM (RFC-6962 0x00/0x01 domain separation,
//         position-bound, NO sorting), plus proveEvent/verifyEvent (single-event inclusion against
//         a head) and proveGrowth/verifyGrowth (append-only consistency between a mid-session
//         checkpoint head and a later/final head) delegating to inclusionProof/verifyInclusion/
//         consistencyProof/verifyConsistency VERBATIM. A sessionHead result doubles as the
//         `{ size, root }` head object those verifiers bind sizes against.
//
//     (d) redactEvent(event): the canonical redacted twin, with the round-trip invariant
//             eventLeaf(redactEvent(e).event) === eventLeaf(e)
//         so a packet holder can withhold any payload AFTER sealing without invalidating the head.
//
// TRUST BOUNDARY (honest, and carried into docs by T-68.4)
//   - `ts` is SELF-ASSERTED metadata: this core records and binds the string but does NOT verify
//     it against any clock (it has no clock). It proves "unaltered since sealed", never
//     "happened at time T".
//   - Garbage-in is out of scope: the head proves the LOG is intact and append-only, not that the
//     log faithfully records what the agent actually did.
//
// PURITY (a hard acceptance criterion, statically guarded by the test)
//   No fs / http / https / net / dns / child_process, no process.env, no clock, no randomness,
//   no signing material. Requires ONLY:
//     - `hashBytes` from cli/hash.js (the pure keccak over in-memory bytes — the ONE symbol
//       imported; none of that module's file-walking helpers are referenced), REUSED not forked;
//     - the five tree functions from cli/journal-log.js, REUSED not forked;
//     - the pure byte helper `toUtf8Bytes` from ethers.
//   Every exported function is TOTAL: hostile input yields a named `{ ok:false, reason }` verdict
//   (or `null` from the leaf generator), never an exception, and results are fully deterministic.

const { hashBytes } = require("../hash");
const {
  treeHead,
  inclusionProof,
  verifyInclusion,
  consistencyProof,
  verifyConsistency,
} = require("../journal-log");
const { toUtf8Bytes } = require("ethers");

// ---------------------------------------------------------------------------------------------------
// Canonical schema constants.
// ---------------------------------------------------------------------------------------------------

// The CLOSED set of event types. A session log is a conversation between an agent and its tools;
// these five cover it. Extending the set is a schema version bump (change LEAF_DOMAIN too) — an
// unknown `type` is a NAMED reject, never silently accepted.
const EVENT_TYPES = Object.freeze(["prompt", "completion", "tool_call", "tool_result", "note"]);

// The exhaustive field set of a canonical event. Any other key is EVENT_UNKNOWN_FIELD: strictness
// here is what makes the leaf encoding total — every byte of an accepted event is either bound
// into the leaf (seq/ts/actor/type/payloadHash/meta) or committed by it (payload).
const EVENT_FIELDS = Object.freeze([
  "seq",
  "ts",
  "actor",
  "type",
  "payload",
  "payloadHash",
  "redacted",
  "meta",
]);

// Domain tag bound into every leaf preimage, so an agent-session leaf can never collide with any
// other artifact this project hashes. Bump the version if the encoding ever changes.
const LEAF_DOMAIN = "vh.agent-session/v1:event-leaf";

// Maximum nesting depth accepted for `meta`. The cap keeps canonicalization total on hostile
// input: a cyclic or absurdly deep object bottoms out at the cap and is REJECTED (EVENT_BAD_META)
// instead of overflowing the stack.
const META_MAX_DEPTH = 32;

// Maximum TOTAL number of values canonicalization may visit for one `meta`. The DEPTH cap alone
// stops cycles and deep-linear objects but NOT breadth blowup from SHARED references: a meta that
// reuses one child twice per level (`let n={leaf:1}; for(i<24) n={a:n,b:n};`) is O(24) objects in
// memory yet, without a budget, forces ~2^24 recursive visits (confirmed: OOM-kill / uncatchable
// SIGKILL, not a named verdict). A per-canonicalization work budget makes the cost O(budget)
// regardless of object-graph shape, so shared-DAG meta is REJECTED (EVENT_BAD_META), never a hang.
// Generous enough that any realistic JSON-shaped metadata passes; JSON text cannot even express
// sharing, so JSON.parse'd callers never approach it.
const META_MAX_NODES = 100000;

// Stable, named reason codes — the verdict contract callers (and the T-68.2 CLI) rely on.
const REASONS = Object.freeze({
  EVENT_NOT_OBJECT: "EVENT_NOT_OBJECT",
  EVENT_UNKNOWN_FIELD: "EVENT_UNKNOWN_FIELD",
  EVENT_BAD_SEQ: "EVENT_BAD_SEQ",
  EVENT_BAD_TS: "EVENT_BAD_TS",
  EVENT_BAD_ACTOR: "EVENT_BAD_ACTOR",
  EVENT_BAD_TYPE: "EVENT_BAD_TYPE",
  EVENT_BAD_PAYLOAD: "EVENT_BAD_PAYLOAD",
  EVENT_BAD_PAYLOAD_HASH: "EVENT_BAD_PAYLOAD_HASH",
  EVENT_PAYLOAD_HASH_MISMATCH: "EVENT_PAYLOAD_HASH_MISMATCH",
  EVENT_BAD_REDACTED_FLAG: "EVENT_BAD_REDACTED_FLAG",
  EVENT_REDACTED_WITH_PAYLOAD: "EVENT_REDACTED_WITH_PAYLOAD",
  EVENT_UNFLAGGED_REDACTION: "EVENT_UNFLAGGED_REDACTION",
  EVENT_MISSING_PAYLOAD: "EVENT_MISSING_PAYLOAD",
  EVENT_BAD_META: "EVENT_BAD_META",
  SESSION_NOT_ARRAY: "SESSION_NOT_ARRAY",
  SESSION_SEQ_NOT_CONTIGUOUS: "SESSION_SEQ_NOT_CONTIGUOUS",
  INDEX_OUT_OF_RANGE: "INDEX_OUT_OF_RANGE",
  PROOF_MALFORMED: "PROOF_MALFORMED",
  PROOF_SEQ_MISMATCH: "PROOF_SEQ_MISMATCH",
  EVENT_NOT_IN_HEAD: "EVENT_NOT_IN_HEAD",
  GROWTH_RANGE: "GROWTH_RANGE",
  GROWTH_NOT_APPEND_ONLY: "GROWTH_NOT_APPEND_ONLY",
  HOSTILE_INPUT: "HOSTILE_INPUT",
});

const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;

function _isHex32(x) {
  return typeof x === "string" && HEX32_RE.test(x);
}

// A "plain" object: prototype is Object.prototype or null. Rejecting exotic objects (class
// instances, Maps, proxies-over-arrays, etc.) keeps canonicalization honest — what we hash is
// exactly the JSON-shaped data the caller could write to disk and read back.
function _isPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// ---------------------------------------------------------------------------------------------------
// Canonical JSON — deterministic, total serialization for `meta`.
//   - objects serialize with keys SORTED (UTF-16 code-unit order), so two semantically equal metas
//     always hash identically regardless of insertion order;
//   - only JSON-representable values are accepted: null, booleans, FINITE numbers, strings, arrays,
//     plain objects. Anything else (undefined, functions, symbols, bigints, NaN/Infinity, class
//     instances) -> null (reject);
//   - depth is capped at META_MAX_DEPTH, which also terminates cycles -> null (reject);
//   - a shared, mutable `budget` counts EVERY value visited across the whole traversal and caps it
//     at META_MAX_NODES, so a shared-reference DAG (O(k) objects, ~2^k visits) is REJECTED instead
//     of hanging/OOM-ing. Preferred over a WeakSet-on-path (catches cycles but not diamond fan-out)
//     and over a never-removed identity Set (which would spuriously reject legitimate immutable
//     sub-object reuse). Callers pass a fresh `{ n: 0 }` per `meta`.
// Returns the canonical JSON text, or null if the value is not canonicalizable (or blows the budget).
// ---------------------------------------------------------------------------------------------------

function _canonicalJson(value, depth, budget) {
  if (depth > META_MAX_DEPTH) return null;
  if (++budget.n > META_MAX_NODES) return null; // total-work budget: bounds shared-reference fan-out
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const parts = [];
    for (const item of value) {
      const p = _canonicalJson(item, depth + 1, budget);
      if (p === null) return null;
      parts.push(p);
    }
    return "[" + parts.join(",") + "]";
  }
  if (_isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const k of keys) {
      const p = _canonicalJson(value[k], depth + 1, budget);
      if (p === null) return null;
      parts.push(JSON.stringify(k) + ":" + p);
    }
    return "{" + parts.join(",") + "}";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Payload commitment.
// ---------------------------------------------------------------------------------------------------

/**
 * The hash commitment of a payload: cli/hash.js `hashBytes` (keccak256, the primitive every other
 * artifact in this project already trusts) over the UTF-8 bytes of the payload STRING. Payloads are
 * strings by contract — a caller with structured data serializes it (deterministically, if they
 * ever want to re-derive the commitment) BEFORE logging. TOTAL: non-string -> null, and a string
 * that is not valid UTF-16 (a lone/unpaired surrogate — legal in JS, produced by truncated log
 * fields or UTF-16 slicing) -> null too, since ethers' toUtf8Bytes THROWS INVALID_ARGUMENT on it.
 * Never throws.
 *
 * @param {string} payload
 * @returns {string|null} 0x bytes32 (lowercase), or null if `payload` is not a UTF-8-encodable string.
 */
function payloadHash(payload) {
  if (typeof payload !== "string") return null;
  try {
    return hashBytes(toUtf8Bytes(payload));
  } catch (_) {
    // Lone/unpaired UTF-16 surrogate: a legal JS string with no UTF-8 encoding. Return null so the
    // function stays TOTAL, exactly like every other exported entry point in this module.
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// Event validation.
// ---------------------------------------------------------------------------------------------------

/**
 * STRICT validation of one canonical event. Never throws; every failure is a named reject.
 *
 * Accepted shapes (exactly two):
 *   FULL:     `payload` is a string; `redacted` absent or false; `payloadHash` optional but, if
 *             present, MUST equal the recomputed commitment (case-insensitively).
 *   REDACTED: `payload` absent; `payloadHash` is a 0x-bytes32 hex commitment; `redacted` MUST be
 *             exactly true (a missing payload without the explicit flag is EVENT_UNFLAGGED_REDACTION
 *             — redaction is always a declared act, never an accident).
 * Common to both: `seq` a non-negative safe integer; `ts` any string (SELF-ASSERTED, untrusted —
 * bound into the leaf but never interpreted); `actor` a non-empty string; `type` from EVENT_TYPES;
 * `meta` (optional) any canonicalizable JSON value; NO other keys.
 *
 * @param {object} event
 * @returns {{ ok: true, redacted: boolean, payloadHash: string, metaJson: string|null }
 *         | { ok: false, reason: string, field?: string }}
 *         On ok: `payloadHash` is the normalized (lowercase) commitment — recomputed from `payload`
 *         when present, taken from the carried commitment when redacted; `metaJson` is the
 *         canonical meta text (null when `meta` is absent).
 */
function validateEvent(event) {
  try {
    if (!_isPlainObject(event)) return { ok: false, reason: REASONS.EVENT_NOT_OBJECT };
    for (const k of Object.keys(event)) {
      if (!EVENT_FIELDS.includes(k)) {
        return { ok: false, reason: REASONS.EVENT_UNKNOWN_FIELD, field: k };
      }
    }
    if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
      return { ok: false, reason: REASONS.EVENT_BAD_SEQ, field: "seq" };
    }
    if (typeof event.ts !== "string") {
      return { ok: false, reason: REASONS.EVENT_BAD_TS, field: "ts" };
    }
    if (typeof event.actor !== "string" || event.actor.length === 0) {
      return { ok: false, reason: REASONS.EVENT_BAD_ACTOR, field: "actor" };
    }
    if (!EVENT_TYPES.includes(event.type)) {
      return { ok: false, reason: REASONS.EVENT_BAD_TYPE, field: "type" };
    }
    const hasPayload = "payload" in event;
    const hasHash = "payloadHash" in event;
    if (hasPayload && typeof event.payload !== "string") {
      return { ok: false, reason: REASONS.EVENT_BAD_PAYLOAD, field: "payload" };
    }
    if (hasHash && !_isHex32(event.payloadHash)) {
      return { ok: false, reason: REASONS.EVENT_BAD_PAYLOAD_HASH, field: "payloadHash" };
    }
    if ("redacted" in event && typeof event.redacted !== "boolean") {
      return { ok: false, reason: REASONS.EVENT_BAD_REDACTED_FLAG, field: "redacted" };
    }
    if (!hasPayload && !hasHash) {
      return { ok: false, reason: REASONS.EVENT_MISSING_PAYLOAD, field: "payload" };
    }
    if (event.redacted === true && hasPayload) {
      return { ok: false, reason: REASONS.EVENT_REDACTED_WITH_PAYLOAD, field: "redacted" };
    }
    if (event.redacted === true && !hasHash) {
      return { ok: false, reason: REASONS.EVENT_BAD_PAYLOAD_HASH, field: "payloadHash" };
    }
    if (!hasPayload && event.redacted !== true) {
      return { ok: false, reason: REASONS.EVENT_UNFLAGGED_REDACTION, field: "redacted" };
    }

    // The commitment: recomputed from the payload when present (and cross-checked against any
    // carried payloadHash), taken from the carried commitment when redacted.
    let commitment;
    if (hasPayload) {
      commitment = payloadHash(event.payload);
      if (commitment === null) {
        // A lone/unpaired UTF-16 surrogate is a legal JS string with no UTF-8 commitment: a
        // SPECIFIC, named reject for the payload field rather than a generic HOSTILE_INPUT.
        return { ok: false, reason: REASONS.EVENT_BAD_PAYLOAD, field: "payload" };
      }
      if (hasHash && commitment !== event.payloadHash.toLowerCase()) {
        return { ok: false, reason: REASONS.EVENT_PAYLOAD_HASH_MISMATCH, field: "payloadHash" };
      }
    } else {
      commitment = event.payloadHash.toLowerCase();
    }

    let metaJson = null;
    if ("meta" in event) {
      metaJson = _canonicalJson(event.meta, 0, { n: 0 });
      if (metaJson === null) return { ok: false, reason: REASONS.EVENT_BAD_META, field: "meta" };
    }

    return { ok: true, redacted: !hasPayload, payloadHash: commitment, metaJson };
  } catch (_) {
    // Hostile exotica (throwing getters, etc.) must never escape as an exception.
    return { ok: false, reason: REASONS.HOSTILE_INPUT };
  }
}

// ---------------------------------------------------------------------------------------------------
// The redaction-safe leaf.
// ---------------------------------------------------------------------------------------------------

/**
 * The Merkle LEAF VALUE of one canonical event — the redaction-safe commitment handed to
 * cli/journal-log.js treeHead (which applies its own RFC-6962 0x00 leaf tag on top).
 *
 * The preimage is the fixed-position JSON array
 *   [ LEAF_DOMAIN, seq, ts, actor, type, payloadHash, canonicalMetaJson|null ]
 * so every bound field edit changes the leaf, while the payload participates ONLY via its
 * commitment: a full event and its redacted twin hash to the IDENTICAL leaf. The presentation-only
 * `redacted` flag is deliberately NOT bound (it is derivable: payload absent <=> redacted). TOTAL:
 * invalid event -> null (journal-log generator convention), never throws.
 *
 * @param {object} event a canonical event (full or redacted).
 * @returns {string|null} 0x bytes32 leaf value, or null if the event does not validate.
 */
function eventLeaf(event) {
  try {
    const v = validateEvent(event);
    if (!v.ok) return null;
    const encoded = JSON.stringify([
      LEAF_DOMAIN,
      event.seq,
      event.ts,
      event.actor,
      event.type,
      v.payloadHash,
      v.metaJson,
    ]);
    return hashBytes(toUtf8Bytes(encoded));
  } catch (_) {
    return null;
  }
}

/**
 * The canonical REDACTED TWIN of an event: payload dropped, its commitment carried, `redacted: true`
 * declared, `meta` (when present) deep-copied in canonical form. Round-trip invariant (tested):
 *   eventLeaf(redactEvent(e).event) === eventLeaf(e)
 * Idempotent: redacting an already-redacted event yields an equal twin. Never throws.
 *
 * @param {object} event a canonical event (full or redacted).
 * @returns {{ ok: true, event: object } | { ok: false, reason: string, field?: string }}
 */
function redactEvent(event) {
  try {
    const v = validateEvent(event);
    if (!v.ok) return v;
    const twin = {
      seq: event.seq,
      ts: event.ts,
      actor: event.actor,
      type: event.type,
      payloadHash: v.payloadHash,
      redacted: true,
    };
    // Canonical deep copy: the twin never aliases caller-mutable state.
    if (v.metaJson !== null) twin.meta = JSON.parse(v.metaJson);
    return { ok: true, event: twin };
  } catch (_) {
    return { ok: false, reason: REASONS.HOSTILE_INPUT };
  }
}

// ---------------------------------------------------------------------------------------------------
// The ordered session log.
// ---------------------------------------------------------------------------------------------------

/**
 * Validate a whole session: an ARRAY of canonical events whose `seq` values are CONTIGUOUS from 0
 * (events[i].seq === i — `seq` is the tree position, which is what makes an inclusion proof bind an
 * event to its place in the conversation). Named, LOCATED rejects; never throws.
 *
 * @param {object[]} events
 * @returns {{ ok: true, size: number } | { ok: false, reason: string, index?: number, field?: string }}
 */
function validateSession(events) {
  try {
    if (!Array.isArray(events)) return { ok: false, reason: REASONS.SESSION_NOT_ARRAY };
    for (let i = 0; i < events.length; i++) {
      const v = validateEvent(events[i]);
      if (!v.ok) return { ok: false, reason: v.reason, index: i, field: v.field };
      if (events[i].seq !== i) {
        return { ok: false, reason: REASONS.SESSION_SEQ_NOT_CONTIGUOUS, index: i };
      }
    }
    return { ok: true, size: events.length };
  } catch (_) {
    return { ok: false, reason: REASONS.HOSTILE_INPUT };
  }
}

/**
 * The session HEAD: cli/journal-log.js `treeHead` (REUSED VERBATIM — RFC-6962, position-bound,
 * no sorting) over the ordered event leaves. Because leaves are redaction-safe, a fully or
 * partially redacted session derives the IDENTICAL head as the full one.
 *
 * The ok-result is itself a valid `{ size, root }` head object, so it can be handed directly to
 * verifyEvent/verifyGrowth (and to journal-log's own verifiers), which then BIND the size.
 * An empty session is a legal (pre-first-event) checkpoint: { size: 0, root: EMPTY_ROOT }.
 *
 * @param {object[]} events
 * @returns {{ ok: true, size: number, root: string }
 *         | { ok: false, reason: string, index?: number, field?: string }}
 */
function sessionHead(events) {
  try {
    const s = validateSession(events);
    if (!s.ok) return s;
    const head = treeHead(events.map((e) => eventLeaf(e)));
    if (head.root === null) return { ok: false, reason: REASONS.HOSTILE_INPUT }; // unreachable post-validation
    return { ok: true, size: head.size, root: head.root };
  } catch (_) {
    return { ok: false, reason: REASONS.HOSTILE_INPUT };
  }
}

// ---------------------------------------------------------------------------------------------------
// Single-event inclusion: proveEvent -> verifyEvent.
// ---------------------------------------------------------------------------------------------------

/**
 * Build a disclosure proof for the event at `index`: the event itself (full or redacted, exactly as
 * held — redact first for a redacted disclosure) plus the journal-log inclusion path. The raw leaf
 * is deliberately NOT carried: verifyEvent must re-derive it from the disclosed event, so the proof
 * is bound to the event DATA, never to a self-asserted hash.
 *
 * @param {object[]} events the full (or redacted-twin) session.
 * @param {number} index 0 <= index < events.length.
 * @returns {{ ok: true, proof: { event: object, inclusion: { leafIndex: number, treeSize: number, path: string[] } } }
 *         | { ok: false, reason: string, index?: number, field?: string }}
 */
function proveEvent(events, index) {
  try {
    const s = validateSession(events);
    if (!s.ok) return s;
    if (!Number.isInteger(index) || index < 0 || index >= events.length) {
      return { ok: false, reason: REASONS.INDEX_OUT_OF_RANGE };
    }
    const ip = inclusionProof(events.map((e) => eventLeaf(e)), index);
    if (ip === null) return { ok: false, reason: REASONS.HOSTILE_INPUT }; // unreachable post-validation
    return {
      ok: true,
      proof: {
        // Deep copy (events validate as JSON-shaped data), so the proof never aliases caller state.
        event: JSON.parse(JSON.stringify(events[index])),
        inclusion: { leafIndex: ip.leafIndex, treeSize: ip.treeSize, path: ip.path },
      },
    };
  } catch (_) {
    return { ok: false, reason: REASONS.HOSTILE_INPUT };
  }
}

/**
 * Verify a single-event disclosure against a TRUSTED head.
 *
 * Re-validates the disclosed event, recomputes `payloadHash` from `payload` when present (checking
 * any carried commitment) or takes the commitment when redacted, re-derives the LEAF from that —
 * never trusting a carried hash — checks `seq === leafIndex` (the event's claimed position IS its
 * tree position), then delegates to cli/journal-log.js verifyInclusion VERBATIM. Passing the full
 * `{ size, root }` head (e.g. a sessionHead result) also BINDS the tree size, so a proof replayed
 * against a different-sized head is rejected outright. Never throws.
 *
 * @param {{ event: object, inclusion: { leafIndex: number, treeSize: number, path: string[] } }} proof
 * @param {string|{size:number,root:string}} head trusted root, or full head (RECOMMENDED).
 * @returns {{ ok: true, seq: number, redacted: boolean } | { ok: false, reason: string, field?: string }}
 */
function verifyEvent(proof, head) {
  try {
    if (!_isPlainObject(proof)) return { ok: false, reason: REASONS.PROOF_MALFORMED };
    const v = validateEvent(proof.event);
    if (!v.ok) return { ok: false, reason: v.reason, field: v.field };
    const inc = proof.inclusion;
    if (!_isPlainObject(inc)) return { ok: false, reason: REASONS.PROOF_MALFORMED };
    if (proof.event.seq !== inc.leafIndex) {
      return { ok: false, reason: REASONS.PROOF_SEQ_MISMATCH };
    }
    const leaf = eventLeaf(proof.event);
    if (leaf === null) return { ok: false, reason: REASONS.PROOF_MALFORMED }; // unreachable post-validation
    const included = verifyInclusion(
      { leaf, leafIndex: inc.leafIndex, treeSize: inc.treeSize, path: inc.path },
      head
    );
    if (!included) return { ok: false, reason: REASONS.EVENT_NOT_IN_HEAD };
    return { ok: true, seq: proof.event.seq, redacted: v.redacted };
  } catch (_) {
    return { ok: false, reason: REASONS.HOSTILE_INPUT };
  }
}

// ---------------------------------------------------------------------------------------------------
// Append-only growth: proveGrowth -> verifyGrowth.
// ---------------------------------------------------------------------------------------------------

/**
 * Build the append-only consistency proof between the size-`firstSize` checkpoint prefix and the
 * size-`secondSize` (default: full) prefix of `events`, delegating to cli/journal-log.js
 * consistencyProof VERBATIM. 1 <= firstSize <= secondSize <= events.length.
 *
 * @param {object[]} events
 * @param {number} firstSize the earlier checkpoint size (m).
 * @param {number} [secondSize] the later size (n); defaults to events.length.
 * @returns {{ ok: true, proof: { firstSize: number, secondSize: number, path: string[] } }
 *         | { ok: false, reason: string, index?: number, field?: string }}
 */
function proveGrowth(events, firstSize, secondSize) {
  try {
    const s = validateSession(events);
    if (!s.ok) return s;
    const n = secondSize === undefined ? events.length : secondSize;
    if (
      !Number.isInteger(firstSize) ||
      !Number.isInteger(n) ||
      firstSize < 1 ||
      n < firstSize ||
      n > events.length
    ) {
      return { ok: false, reason: REASONS.GROWTH_RANGE };
    }
    const cp = consistencyProof(events.map((e) => eventLeaf(e)), firstSize, n);
    if (cp === null) return { ok: false, reason: REASONS.HOSTILE_INPUT }; // unreachable post-validation
    return { ok: true, proof: cp };
  } catch (_) {
    return { ok: false, reason: REASONS.HOSTILE_INPUT };
  }
}

/**
 * Verify that `laterHead` is an APPEND-ONLY extension of `earlierHead` — i.e. that no event at or
 * before the checkpoint was rewritten, reordered, dropped or inserted between the two heads.
 * Delegates to cli/journal-log.js verifyConsistency VERBATIM; passing full `{ size, root }` heads
 * (e.g. sessionHead results — RECOMMENDED) also BINDS both sizes, so a proof lying about either
 * size is rejected outright. Never throws.
 *
 * @param {string|{size:number,root:string}} earlierHead the checkpoint head (size m).
 * @param {string|{size:number,root:string}} laterHead the later/final head (size n >= m).
 * @param {{ firstSize: number, secondSize: number, path: string[] }} proof
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function verifyGrowth(earlierHead, laterHead, proof) {
  try {
    if (!_isPlainObject(proof)) return { ok: false, reason: REASONS.PROOF_MALFORMED };
    const consistent = verifyConsistency(proof, earlierHead, laterHead);
    if (!consistent) return { ok: false, reason: REASONS.GROWTH_NOT_APPEND_ONLY };
    return { ok: true };
  } catch (_) {
    return { ok: false, reason: REASONS.HOSTILE_INPUT };
  }
}

module.exports = {
  // Schema + verdict contract.
  EVENT_TYPES,
  EVENT_FIELDS,
  LEAF_DOMAIN,
  META_MAX_DEPTH,
  META_MAX_NODES,
  REASONS,
  // The core operations.
  payloadHash,
  validateEvent,
  eventLeaf,
  redactEvent,
  validateSession,
  sessionHead,
  proveEvent,
  verifyEvent,
  proveGrowth,
  verifyGrowth,
};

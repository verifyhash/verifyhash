"use strict";

// cli/journal.js — the pure, transport/filesystem-agnostic INTEGRITY-JOURNAL CORE (T-60.1).
//
// WHY THIS EXISTS (EPIC-60, integrity OVER TIME)
//   Every other surface in this project — CLI verify, verify-vh, serve-verify, the SDK, the GitHub
//   Action — answers "do these exact bytes match this seal RIGHT NOW?" and then EXITS. This module is
//   the structurally-new capability: an APPEND-ONLY, HASH-CHAINED journal of verify verdicts. Each run
//   appends one entry; the log is ITSELF tamper-evident, so a deleted / edited / reordered / inserted
//   past entry BREAKS the chain and `verifyJournal` LOCALIZES the first break. That is the "verified
//   CONTINUOUSLY from date A to B, and here is the exact entry where one drifted" artifact a one-shot
//   verify cannot produce.
//
// PURITY (a hard acceptance criterion)
//   This file is TRANSPORT- and FILESYSTEM-agnostic: it does NO disk I/O, opens NO socket, and holds no
//   signing material. It requires ONLY:
//     - `hashBytes` (keccak256 of in-memory bytes) from cli/hash.js — the SAME hash the project already
//       trusts for seals/Merkle roots, REUSED verbatim; NO new crypto is invented here.
//     - `toUtf8Bytes` from ethers — a pure string-to-bytes encoder (NOT a network or signing primitive).
//   A grep in test/journal.core.test.js asserts this file requires NONE of http/https/net/dns and does no
//   signer/keyfile work at all.
//
// THE CHAIN (the exact transparency-log shape the project already uses for seals, reused)
//   An entry is:
//     { seq, prevHash, ts, artifact, verdict, entryHash }
//   where:
//     - seq       : 0-based position in the journal (a genesis append is seq 0).
//     - prevHash  : the PRIOR entry's entryHash, or the documented GENESIS constant for seq 0.
//     - ts        : a SELF-ASSERTED wall-clock instant the caller supplies (an ISO string / number /
//                   anything JSON-serializable). The journal proves ORDERING + CONTINUITY of the
//                   verifier's OWN observations; it stays HONEST that `ts` is self-asserted until a
//                   trust-root signs/timestamps it — it NEVER claims "unaltered since date T" unqualified.
//     - artifact  : a caller-supplied label for WHAT was observed (e.g. a path / id). Stored verbatim.
//     - verdict   : the verify verdict this entry records, stored VERBATIM (deep-equal to the
//                   `verifyRequest` output it was built from — a test asserts this).
//     - entryHash : hashBytes(canonical({ seq, prevHash, ts, artifact, verdict })). Because `prevHash`
//                   is folded in, each entryHash commits to the ENTIRE prefix before it — editing any
//                   past field, deleting/reordering/inserting an entry changes some downstream prevHash
//                   or entryHash and BREAKS the chain.
//
// The canonical serializer sorts object keys RECURSIVELY so the entryHash is independent of the key
// INSERTION order in the caller's `verdict`/`observation` objects (two logically-identical observations
// hash identically) while still being a total, injective encoding of the value.

const { toUtf8Bytes } = require("ethers");
const { hashBytes } = require("./hash");

// ---------------------------------------------------------------------------------------------------
// Documented constants
// ---------------------------------------------------------------------------------------------------

// The GENESIS prevHash for seq 0. It is keccak256 of the fixed domain string below — a deterministic,
// documented, journal-specific constant (NOT a real prior entry's hash). Domain-separating it keeps a
// genesis prevHash from ever colliding with a real entryHash of some crafted entry.
const GENESIS_DOMAIN = "vh.integrity-journal/v1:genesis";
const GENESIS_PREV_HASH = hashBytes(toUtf8Bytes(GENESIS_DOMAIN));

// A schema/version tag folded into every entryHash so a v1 entry can never be replayed as a future
// v2 entry with a different meaning. Bump ONLY on a breaking change to the entry shape.
const JOURNAL_SCHEMA = "vh.integrity-journal/v1";

// ---------------------------------------------------------------------------------------------------
// Canonical serialization — a recursive, key-sorted, deterministic JSON encoder (RFC-8785-style, kept
// minimal). PURE. This is what makes the entryHash byte-identical for logically-identical inputs.
// ---------------------------------------------------------------------------------------------------

/**
 * Deterministically serialize a JSON value: object keys sorted recursively, arrays order-preserved,
 * NO insignificant whitespace. Rejects values JSON cannot faithfully round-trip (undefined, function,
 * symbol, BigInt, non-finite number) so a malformed observation NEVER silently produces a stable hash
 * that hides a lossy value — it throws, and appendEntry surfaces that as a clean error.
 * @param {*} value
 * @returns {string}
 */
function canonicalize(value) {
  return _canon(value);
}

function _canon(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value); // JSON.stringify escapes a string correctly + deterministically
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(value)) {
      throw new JournalError(`cannot canonicalize a non-finite number: ${String(value)}`);
    }
    // JSON's number grammar; V8 emits the shortest round-tripping form deterministically.
    return JSON.stringify(value);
  }
  if (t === "bigint") {
    throw new JournalError("cannot canonicalize a BigInt (not valid JSON)");
  }
  if (t === "undefined" || t === "function" || t === "symbol") {
    throw new JournalError(`cannot canonicalize a value of type ${t} (not valid JSON)`);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => _canon(v)).join(",") + "]";
  }
  if (t === "object") {
    // Plain object: sort keys for a deterministic, insertion-order-independent encoding. A key whose
    // value is undefined/function/symbol is DROPPED (matching JSON.stringify), so it cannot smuggle a
    // non-JSON value into the hash.
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const k of keys) {
      const v = value[k];
      if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
      parts.push(JSON.stringify(k) + ":" + _canon(v));
    }
    return "{" + parts.join(",") + "}";
  }
  // Unreachable for JSON values, but fail closed rather than emit something lossy.
  throw new JournalError(`cannot canonicalize a value of type ${t}`);
}

// ---------------------------------------------------------------------------------------------------
// Errors — a named class so callers/tests can distinguish a journal-shape error from anything else.
// ---------------------------------------------------------------------------------------------------

class JournalError extends Error {
  constructor(message) {
    super(message);
    this.name = "JournalError";
  }
}

// ---------------------------------------------------------------------------------------------------
// entryHash — the chain link. hashBytes(canonical(preimage)) where the preimage folds in the schema
// tag, seq, prevHash, ts, artifact and verdict. PURE.
// ---------------------------------------------------------------------------------------------------

/**
 * Compute the canonical entryHash for the given entry fields. Deterministic: identical inputs ⇒
 * byte-identical hash. Exposed so a verifier can RE-DERIVE it independently of how the entry was built.
 * @param {object} fields { seq, prevHash, ts, artifact, verdict }
 * @returns {string} 0x-prefixed keccak256
 */
function computeEntryHash(fields) {
  const preimage = {
    schema: JOURNAL_SCHEMA,
    seq: fields.seq,
    prevHash: fields.prevHash,
    ts: fields.ts,
    artifact: fields.artifact,
    verdict: fields.verdict,
  };
  return hashBytes(toUtf8Bytes(canonicalize(preimage)));
}

// ---------------------------------------------------------------------------------------------------
// appendEntry(priorEntry|null, observation) — build the NEXT entry. PURE (returns a new object; does
// NOT mutate priorEntry, does NO I/O).
// ---------------------------------------------------------------------------------------------------

/**
 * Build the next journal entry that chains onto `priorEntry`.
 *
 *   appendEntry(null, obs)      -> seq 0, prevHash = GENESIS_PREV_HASH
 *   appendEntry(entryN, obs)    -> seq N+1, prevHash = entryN.entryHash
 *
 * @param {object|null} priorEntry  the previous entry, or null for the genesis (seq 0) append.
 * @param {object} observation      { verdict, artifact?, ts? }
 *                                    - verdict  (required) the verify verdict to record. Stored VERBATIM
 *                                      (deep-equal to the verifyRequest output it was built from).
 *                                    - artifact (optional, default null) a label for what was observed.
 *                                    - ts       (optional, default null) a SELF-ASSERTED timestamp.
 * @returns {object} a NEW entry { seq, prevHash, ts, artifact, verdict, entryHash }.
 * @throws {JournalError} on a malformed priorEntry/observation (never a silent bad chain).
 */
function appendEntry(priorEntry, observation) {
  if (observation === null || typeof observation !== "object" || Array.isArray(observation)) {
    throw new JournalError("observation must be an object { verdict, artifact?, ts? }");
  }
  if (!("verdict" in observation)) {
    throw new JournalError("observation.verdict is required");
  }
  const verdict = observation.verdict;
  if (verdict === undefined) {
    throw new JournalError("observation.verdict is required (got undefined)");
  }
  // `artifact` and `ts` default to null (a stable, canonicalizable placeholder) when omitted.
  const artifact = observation.artifact === undefined ? null : observation.artifact;
  const ts = observation.ts === undefined ? null : observation.ts;

  let seq;
  let prevHash;
  if (priorEntry === null || priorEntry === undefined) {
    seq = 0;
    prevHash = GENESIS_PREV_HASH;
  } else {
    _assertEntryShape(priorEntry, "priorEntry");
    if (!Number.isInteger(priorEntry.seq) || priorEntry.seq < 0) {
      throw new JournalError(`priorEntry.seq must be a non-negative integer, got ${String(priorEntry.seq)}`);
    }
    seq = priorEntry.seq + 1;
    prevHash = priorEntry.entryHash;
  }

  const entry = {
    seq,
    prevHash,
    ts,
    artifact,
    // Store the verdict VERBATIM. We deep-clone it so a later mutation of the caller's object cannot
    // retroactively change what the journal recorded, while keeping it deep-equal to the input.
    verdict: _deepCloneJson(verdict),
  };
  entry.entryHash = computeEntryHash(entry);
  return entry;
}

// ---------------------------------------------------------------------------------------------------
// verifyJournal(entries[]) — walk the chain, LOCALIZING the first break. PURE. NEVER a false ok:true.
// ---------------------------------------------------------------------------------------------------

/**
 * Verify a full, ordered journal.
 *
 * @param {object[]} entries the journal entries in order (entries[0] must be the genesis, seq 0).
 * @returns {object} on success: { ok:true, count:<n>, head:<last entryHash|GENESIS if empty> }
 *                   on failure: { ok:false, brokenAt:<first broken index>, reason:<string> }
 *
 * A false positive is a security bug: any deviation — a wrong seq, a prevHash that does not match the
 * previous entryHash, an entryHash that does not re-derive from the stored fields, a shape error, or a
 * non-array input — yields ok:false with the FIRST offending index in `brokenAt`. It NEVER throws and
 * NEVER returns ok:true for a tampered chain.
 */
function verifyJournal(entries) {
  if (!Array.isArray(entries)) {
    return { ok: false, brokenAt: 0, reason: "journal must be an array of entries" };
  }
  if (entries.length === 0) {
    // An empty journal is vacuously consistent: no observations, nothing to contradict.
    return { ok: true, count: 0, head: GENESIS_PREV_HASH };
  }

  let expectedPrevHash = GENESIS_PREV_HASH;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];

    // 1) Shape: a non-object / missing-field entry is the first break at i.
    const shapeErr = _entryShapeError(e);
    if (shapeErr) {
      return { ok: false, brokenAt: i, reason: `entry ${i}: ${shapeErr}` };
    }

    // 2) seq must equal its position — catches a reordering, a deletion, or an insertion that shifts seqs.
    if (e.seq !== i) {
      return {
        ok: false,
        brokenAt: i,
        reason: `entry ${i}: seq is ${JSON.stringify(e.seq)} but expected ${i} (reordered, deleted, or inserted)`,
      };
    }

    // 3) prevHash must chain from the previous entry's entryHash (or GENESIS at seq 0).
    if (e.prevHash !== expectedPrevHash) {
      return {
        ok: false,
        brokenAt: i,
        reason:
          i === 0
            ? `entry 0: prevHash ${JSON.stringify(e.prevHash)} is not the genesis constant`
            : `entry ${i}: prevHash does not match entry ${i - 1}'s entryHash (chain broken)`,
      };
    }

    // 4) entryHash must RE-DERIVE from the stored fields — catches an edit to verdict/ts/artifact/seq/prevHash.
    const recomputed = computeEntryHash(e);
    if (recomputed !== e.entryHash) {
      return {
        ok: false,
        brokenAt: i,
        reason: `entry ${i}: entryHash does not match its contents (a field was edited or forged)`,
      };
    }

    expectedPrevHash = e.entryHash;
  }

  return { ok: true, count: entries.length, head: expectedPrevHash };
}

// ---------------------------------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------------------------------

// Returns a human-readable reason string if `e` is not a well-shaped entry, else null. Used by
// verifyJournal so a malformed entry is a LOCALIZED break rather than a throw.
function _entryShapeError(e) {
  if (e === null || typeof e !== "object" || Array.isArray(e)) {
    return "not an object";
  }
  if (!Number.isInteger(e.seq) || e.seq < 0) {
    return `seq must be a non-negative integer, got ${JSON.stringify(e.seq)}`;
  }
  if (typeof e.prevHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(e.prevHash)) {
    return "prevHash must be a 0x-prefixed 32-byte hex string";
  }
  if (typeof e.entryHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(e.entryHash)) {
    return "entryHash must be a 0x-prefixed 32-byte hex string";
  }
  if (!("verdict" in e)) {
    return "verdict is missing";
  }
  return null;
}

// Throwing variant used by appendEntry on the priorEntry (a caller error, not a localized chain break).
function _assertEntryShape(e, label) {
  const err = _entryShapeError(e);
  if (err) throw new JournalError(`${label}: ${err}`);
}

// Deep-clone a JSON value, detaching it from the caller's object while keeping it deep-equal to the
// input (a test asserts deepEqual). We route the clone through `canonicalize` FIRST: a non-JSON value
// (BigInt, function, non-finite number, symbol) throws a clean JournalError here — never a raw TypeError
// and never a silently-dropped field. The canonical string is a valid JSON encoding of the value, so
// JSON.parse reconstructs a faithful, key-sorted deep copy.
function _deepCloneJson(value) {
  return JSON.parse(canonicalize(value === undefined ? null : value));
}

module.exports = {
  appendEntry,
  verifyJournal,
  computeEntryHash,
  canonicalize,
  JournalError,
  GENESIS_PREV_HASH,
  GENESIS_DOMAIN,
  JOURNAL_SCHEMA,
};
